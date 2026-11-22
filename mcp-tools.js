const object = properties => ({ type: "object", properties, additionalProperties: false });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const requestId = { type: "string", minLength: 1, maxLength: 100 };
const queue = { type: "string", enum: ["gpt", "tripo"] };
export const TOOLS = [
  { name: "runner_status", description: "Read shared queue state and tabs. Optional requestId filters GPT items and reports known or removed records; Tripo remains shared. Runs continue asynchronously.", inputSchema: object({ offset: integer(0, 1000000), limit: integer(1, 50), requestId }) },
  { name: "runner_open_tab", description: "Open ChatGPT for the legacy/manual queue or Tripo Studio for the shared model queue using a fixed service URL. Request batches create their own ChatGPT tabs on start. Uses existing browser sign-in.", inputSchema: { ...object({ queue }), required: ["queue"] } },
  { name: "runner_add_prompts", description: "Append exact prompts to the shared GPT queue without sending. Use a unique stable requestId per chat batch. Retrying the same requestId and exact prompts returns original IDs without duplicates; changed prompts require a new requestId.", inputSchema: { ...object({ requestId, prompts: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 20000 } } }), required: ["prompts"] } },
  { name: "runner_start", description: "Start or resume GPT requestId in its own browser tab; different requests generate concurrently. Without requestId, GPT starts only manual/unscoped prompts. Tripo is shared. Repeated GPT start returns the same active request; stopRequested means new work may remain pending. May send prompts or spend Studio credits within configured ceiling. Returns accepted after startup, not completion. Never automatically resends uncertain work.", inputSchema: { ...object({ queue, requestId }), required: ["queue"] } },
  { name: "runner_stop", description: "Stop one GPT requestId after its current image, or omit requestId to stop all GPT requests. Tripo stop is shared; does not cancel generation.", inputSchema: { ...object({ queue, requestId }), required: ["queue"] } },
  { name: "runner_rescan", description: "Rescan selected folder while Tripo queue is idle.", inputSchema: object({}) },
  { name: "runner_settings", description: "Update shared Tripo limits for all agents while idle. limit=0 means unlimited. watch keeps waiting for root images.", inputSchema: { ...object({ maxCredits: integer(1, 10000), limit: integer(0, 100000), watch: { type: "boolean" } }), minProperties: 1 } },
  { name: "runner_select_tab", description: "Select the idle legacy/manual ChatGPT tab or shared Tripo Studio tab. GPT request batches use their own automatic tabs.", inputSchema: { ...object({ queue, tabId: integer(1, Number.MAX_SAFE_INTEGER) }), required: ["queue", "tabId"] } },
  { name: "runner_clear_finished", description: "Remove saved/failed GPT records; keeps files and request deduplication receipts. Supply requestId to clear only that batch; omission clears all batches.", inputSchema: object({ requestId }) },
  { name: "runner_prompt_action", description: "Explicitly retry or remove one GPT prompt while idle. Supply requestId to require that batch; IDs are correlation labels, not access control. retry resets to pending and permits sending again on next start; may duplicate a previously submitted prompt.", inputSchema: { ...object({ requestId, id: { type: "string", minLength: 1, maxLength: 100 }, action: { type: "string", enum: ["retry", "remove"] } }), required: ["id", "action"] } }
];
const valid = (value, schema) => {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "object") return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => schema.properties[key] && valid(value[key], schema.properties[key])) && (schema.required || []).every(key => Object.hasOwn(value, key)) && Object.keys(value).length >= (schema.minProperties || 0);
  if (schema.type === "array") return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems && value.every(item => valid(item, schema.items));
  if (schema.type === "string") return typeof value === "string" && value.trim().length >= (schema.minLength || 0) && value.length <= (schema.maxLength || Infinity);
  if (schema.type === "integer") return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return typeof value === schema.type;
};
export const validateTool = (name, args) => {
  const tool = TOOLS.find(tool => tool.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (args?.requestId !== undefined && args.queue === "tripo") throw new Error("requestId applies only to GPT requests; Tripo queue is shared.");
  if (!valid(args, tool.inputSchema)) throw new Error(`Invalid arguments for ${name}. See tools/list schema.`);
  return tool;
};
