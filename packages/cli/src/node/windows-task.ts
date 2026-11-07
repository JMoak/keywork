import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privilegeRefusal, qualifiedName } from "./account.ts";
import {
  type Managed,
  type ManagerStatus,
  managed,
  type Registration,
  refused,
  type ServiceManager,
} from "./manager.ts";
import { type CommandRunner, failureText } from "./runner.ts";

export const defaultTaskName = "keywork node";

export interface WindowsTaskOptions {
  run: CommandRunner;
  definitionFile: string;
}

export function windowsTaskManager(options: WindowsTaskOptions): ServiceManager {
  const { run } = options;
  const schtasks = (args: readonly string[]) => run("schtasks", args);
  const registered = async (name: string) => (await schtasks(["/Query", "/TN", name])).code === 0;

  return {
    kind: "windows-task",
    defaultName: defaultTaskName,
    describe: (registration) =>
      `Windows logon task "${registration.name}" for ${qualifiedName(registration.account)} (interactive token, least privilege)`,
    install: async (registration, choices) => {
      const refusal = privilegeRefusal(registration.account, "win32");
      if (refusal !== undefined) return refused(refusal);
      writeTaskDefinition(options.definitionFile, taskXml(registration));
      const did = [`wrote the task definition to ${options.definitionFile}`];
      const createArgs = [
        "/Create",
        "/TN",
        registration.name,
        "/XML",
        options.definitionFile,
        "/F",
      ];
      const created = await schtasks(createArgs);
      if (created.code !== 0) return refused(failureText("schtasks", createArgs, created), did);
      did.push(`registered the logon task "${registration.name}"`);
      return choices.start ? startTask(schtasks, registration.name, did) : managed(did);
    },
    uninstall: async (name) => {
      if (!(await registered(name)))
        return managed([`no logon task named "${name}" was registered`]);
      const ended = await schtasks(["/End", "/TN", name]);
      const did = ended.code === 0 ? [`ended the running task "${name}"`] : [];
      const deleteArgs = ["/Delete", "/TN", name, "/F"];
      const deleted = await schtasks(deleteArgs);
      if (deleted.code !== 0) return refused(failureText("schtasks", deleteArgs, deleted), did);
      return managed([...did, `removed the logon task "${name}"`]);
    },
    start: (name) => startTask(schtasks, name, []),
    stop: async (name) => {
      const ended = await schtasks(["/End", "/TN", name]);
      return managed(ended.code === 0 ? [`ended the running task "${name}"`] : []);
    },
    status: async (name) => taskStatus(schtasks, name),
    program: async (name) => {
      const definition = await schtasks(["/Query", "/TN", name, "/XML"]);
      return definition.code === 0 ? taskCommand(definition.stdout) : undefined;
    },
  };
}

export function taskCommand(xml: string): string | undefined {
  const command = /<Command>([^<]*)<\/Command>/.exec(xml)?.[1];
  return command === undefined ? undefined : unescapedXml(command);
}

export function taskXml(registration: Registration): string {
  const user = xmlText(qualifiedName(registration.account));
  const command = xmlText(registration.launch.program);
  const argumentLine = xmlText(
    [...registration.launch.args, ...registration.args].map(windowsArgument).join(" "),
  );
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>stead node for ${user}: keywork serve per workspace and the mesh listener, under a supervisor that restarts them (adr.node-runs-as-the-logged-in-user)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${argumentLine}</Arguments>
      <WorkingDirectory>${xmlText(registration.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function windowsArgument(argument: string): string {
  if (argument !== "" && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    const escapes = character === '"' ? backslashes * 2 + 1 : backslashes;
    quoted += `${"\\".repeat(escapes)}${character}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function taskDefinitionBytes(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

type Schtasks = (args: readonly string[]) => ReturnType<CommandRunner>;

async function startTask(schtasks: Schtasks, name: string, did: string[]): Promise<Managed> {
  const runArgs = ["/Run", "/TN", name];
  const started = await schtasks(runArgs);
  if (started.code !== 0) return refused(failureText("schtasks", runArgs, started), did);
  return managed([...did, `started the task "${name}"`]);
}

async function taskStatus(schtasks: Schtasks, name: string): Promise<ManagerStatus> {
  const listed = await schtasks(["/Query", "/TN", name, "/FO", "CSV", "/NH"]);
  if (listed.code !== 0) {
    return { installed: false, running: false, state: "not registered", pid: null, notes: [] };
  }
  const state = csvFields(firstLine(listed.stdout))[2] ?? "unknown";
  const definition = await schtasks(["/Query", "/TN", name, "/XML"]);
  return {
    installed: true,
    running: /running/i.test(state),
    state,
    pid: null,
    notes: definition.code === 0 ? principalNotes(definition.stdout) : [],
  };
}

function principalNotes(xml: string): string[] {
  const logonType = /<LogonType>([^<]*)<\/LogonType>/.exec(xml)?.[1];
  const runLevel = /<RunLevel>([^<]*)<\/RunLevel>/.exec(xml)?.[1] ?? "LeastPrivilege";
  return logonType === undefined ? [] : [`logon type ${logonType}, run level ${runLevel}`];
}

function writeTaskDefinition(file: string, xml: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, taskDefinitionBytes(xml));
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}

function csvFields(line: string): string[] {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) =>
    (match[1] ?? "").replaceAll('""', '"'),
  );
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapedXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
