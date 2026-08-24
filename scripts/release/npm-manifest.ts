export interface NpmManifestInputs {
  readonly version: string;
  readonly opentuiVersion: string;
  readonly treeSitterVersion: string;
}

export interface NpmManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly type: "module";
  readonly bin: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly engines: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly repository: { readonly type: string; readonly url: string };
  readonly homepage: string;
}

export const npmBinPath = "bin/keywork.js";

export function npmManifestFor(inputs: NpmManifestInputs): NpmManifest {
  return {
    name: "keywork",
    version: inputs.version,
    description: "a coding-agent harness you play like an instrument",
    license: "FSL-1.1-MIT",
    type: "module",
    bin: { keywork: npmBinPath },
    files: ["bin", "LICENSE.md", "NOTICE", "README.md"],
    engines: { bun: ">=1.3.0" },
    dependencies: {
      "@opentui/core": inputs.opentuiVersion,
      "web-tree-sitter": inputs.treeSitterVersion,
    },
    repository: { type: "git", url: "git+https://github.com/JMoak/keywork.git" },
    homepage: "https://github.com/JMoak/keywork",
  };
}
