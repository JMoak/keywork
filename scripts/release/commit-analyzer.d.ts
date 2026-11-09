declare module "@semantic-release/commit-analyzer" {
  export function analyzeCommits(
    configuration: {
      preset: string;
      releaseRules: readonly {
        type?: string;
        breaking?: boolean;
        revert?: boolean;
        release: "major" | "minor" | "patch" | false;
      }[];
    },
    context: {
      cwd: string;
      commits: readonly { hash: string; message: string }[];
      logger: { log: (...values: unknown[]) => void };
    },
  ): Promise<"major" | "minor" | "patch" | null>;
}
