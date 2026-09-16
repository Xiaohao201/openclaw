# Feed search

`feed_query` is available to authenticated `rabbitmq-<userId>` agents. Authorization
is resolved server-side for each call; tool arguments cannot change user identity.

## Select a project before querying its contents

1. Discover authorized projects with `{"mode":"topics","topicName":"莱州一中"}`.
   `topicName` matches project titles, not article text. Omit it to list projects.
   Results are sorted by ID, with at most 50 per page. Pass `nextOffset` as `offset`
   with the same name filter to retrieve the next page.
2. Select the explicitly named project first, then the project confirmed in this
   conversation. When neither is present and the account has exactly one authorized
   project, select it automatically without asking the user. Unfiltered discovery
   advertises this as `defaultTopic`; a unique filtered match is not an account default.
   Ask for clarification if candidates remain ambiguous. If an explicitly named
   project does not match, try a shorter name or list projects;
   do not substitute an unrelated project or infer that the project does not exist.
   Titles are the available metadata; there is no authoritative alias catalog.
3. Pass the chosen `topicId` to `search` or `stats`. Omitted IDs return
   `TOPIC_REQUIRED`; the agent automatically supplies the sole authorized project's
   ID for unnamed requests. The user does not have to choose or confirm it.
   Existing callers that omitted IDs must discover and select a project.

| Request                                  | Project selection                           | Article filter                                              |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| 今天莱州一中的舆情情况如何？             | Discover 莱州一中                           | Today's dates, no keyword; stats then representative search |
| 莱州一中今天有没有食堂相关内容？         | Discover 莱州一中                           | Today's dates, `keyword: "食堂"`                            |
| 华泰联合证券的监测里有没有提到莱州一中？ | Discover 华泰联合证券                       | `keyword: "莱州一中"`                                       |
| 那昨天呢？                               | Last confirmed project in this conversation | Change dates, retain other filters                          |
| 换成华泰联合证券                         | Discover the new project                    | Clear old content filters unless explicitly retained        |

The model interprets the request using the tool instructions and the existing
conversation history, which is isolated by session ID. The tool does not store
a user-global selected project or infer an ID from previous calls. If conversation
context is missing, rediscover or clarify the project instead of guessing.

Answers should name the queried project and date/filter scope. An empty article
result only establishes no matches within that scope; it does not establish a
lack of project authorization or monitoring coverage. Public web search cannot
substitute for the requested internal monitoring data.
