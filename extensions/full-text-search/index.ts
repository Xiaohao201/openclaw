import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createFullTextSearchTool } from "./src/full-text-search-tool.js";

export default definePluginEntry({
  id: "full-text-search",
  name: "Full Text Search",
  description: "Search indexed cross-platform posts and articles",
  register(api) {
    api.registerTool(createFullTextSearchTool(api), { name: "full_text_search" });
  },
});
