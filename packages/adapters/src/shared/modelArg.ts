/** Append `--model <slug>` when the turn requests a non-default model. */
export function pushModelArg(args: string[], model: string | undefined, flag = "--model"): void {
  if (model && model !== "default") args.push(flag, model);
}
