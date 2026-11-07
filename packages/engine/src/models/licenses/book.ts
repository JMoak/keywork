import { join } from "node:path";
import { jsonFileStore } from "@keywork/shared";
import { z } from "zod";
import { sameLicense } from "./terms.ts";

export interface ModelAcknowledgement {
  model: string;
  license: string;
  acknowledgedAt: string;
}

export interface AcknowledgementRequest {
  endpoint: string;
  model: string;
  license: string;
}

export interface LicenseBook {
  acknowledge(request: AcknowledgementRequest): ModelAcknowledgement;
  acknowledgementOf(model: string, license: string): ModelAcknowledgement | undefined;
}

export interface LicenseBookOptions {
  now?: (() => Date) | undefined;
}

export function modelAcknowledgementsFile(stateDir: string): string {
  return join(stateDir, "models", "acknowledgements.json");
}

export function memoryLicenseBook(options: LicenseBookOptions = {}): LicenseBook {
  let held: AcknowledgementRecord[] = [];
  return bookOver(
    {
      read: () => held,
      write: (records) => {
        held = records;
      },
    },
    options,
  );
}

export function fileLicenseBook(file: string, options: LicenseBookOptions = {}): LicenseBook {
  const store = jsonFileStore({
    file,
    mode: "lenient",
    validate: (data) => acknowledgementsFileSchema.safeParse(data).data ?? noAcknowledgements,
  });
  return bookOver(
    {
      read: () => store.read()?.acknowledgements ?? [],
      write: (acknowledgements) => store.write({ acknowledgements }),
    },
    options,
  );
}

const acknowledgementRecordSchema = z.object({
  model: z.string().min(1),
  license: z.string().min(1),
  endpoint: z.string(),
  acknowledgedAt: z.string(),
});

const acknowledgementsFileSchema = z.object({
  acknowledgements: z.array(acknowledgementRecordSchema),
});

type AcknowledgementRecord = z.infer<typeof acknowledgementRecordSchema>;

const noAcknowledgements: z.infer<typeof acknowledgementsFileSchema> = { acknowledgements: [] };

interface AcknowledgementShelf {
  read(): readonly AcknowledgementRecord[];
  write(records: AcknowledgementRecord[]): void;
}

function bookOver(shelf: AcknowledgementShelf, options: LicenseBookOptions): LicenseBook {
  const now = options.now ?? (() => new Date());
  const recordOf = (model: string, license: string) =>
    shelf.read().find((record) => record.model === model && sameLicense(record.license, license));
  return {
    acknowledge: (request) => {
      const held = recordOf(request.model, request.license);
      if (held !== undefined) return acknowledgementOf(held);
      const record = { ...request, acknowledgedAt: now().toISOString() };
      shelf.write([...shelf.read(), record]);
      return acknowledgementOf(record);
    },
    acknowledgementOf: (model, license) => {
      const held = recordOf(model, license);
      return held === undefined ? undefined : acknowledgementOf(held);
    },
  };
}

function acknowledgementOf({
  model,
  license,
  acknowledgedAt,
}: AcknowledgementRecord): ModelAcknowledgement {
  return { model, license, acknowledgedAt };
}
