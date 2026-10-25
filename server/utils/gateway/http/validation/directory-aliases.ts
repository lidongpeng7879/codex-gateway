import { z } from "zod";

const absoluteDirectory = z
  .string()
  .trim()
  .min(1)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.includes("\0") &&
      !path.split("/").some((part) => part === "." || part === ".."),
    "Use an absolute directory path without . or .. segments",
  );

export const directoryAliasesSchema = z
  .array(
    z
      .object({
        originalPath: absoluteDirectory,
        workspacePath: absoluteDirectory,
      })
      .strict(),
  )
  .max(100)
  .default([])
  .superRefine((aliases, ctx) => {
    const sources = new Set<string>();
    for (const [index, alias] of aliases.entries()) {
      if (sources.has(alias.originalPath)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "originalPath"],
          message: "Each original directory may have only one workspace",
        });
      }
      sources.add(alias.originalPath);
    }
    for (const [index, alias] of aliases.entries()) {
      if (sources.has(alias.workspacePath)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "workspacePath"],
          message:
            "Workspace directories must be final targets; alias chains and cycles are not allowed",
        });
      }
    }
  });
