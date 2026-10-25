import { registerHooks } from "node:module";
import { existsSync, statSync } from "node:fs";
const root = new URL("../../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith("@/")) target = new URL(`app/${specifier.slice(2)}`, root);
    else if (specifier.startsWith("~~/")) target = new URL(specifier.slice(3), root);
    else if (
      specifier.startsWith(".") &&
      context.parentURL?.startsWith(root.href) === true &&
      !context.parentURL.includes("/node_modules/")
    )
      target = new URL(specifier, context.parentURL);
    if (target) {
      if (!existsSync(target) || !statSync(target).isFile()) {
        for (const suffix of [".ts", "/index.ts"]) {
          const candidate = new URL(`${target.href}${suffix}`);
          if (existsSync(candidate)) {
            target = candidate;
            break;
          }
        }
      }
      return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});
