# bitbucket-mcp

An MCP server for Bitbucket Server / Data Center. It wraps the REST 1.0 API so
an agent can work a pull request end to end: list and read PRs, check the merge
state, read the activity thread, post and thread comments, resolve tasks, toggle
the draft flag, and merge.

The official Atlassian MCP for Bitbucket ships only with Data Center 10.5 and
later. This server covers an older Bitbucket Server that does not have it yet,
and the Atlassian Cloud MCP does not reach a self-hosted instance.

## Configuration

The host and credentials come from the environment. No server URL is baked into
the code, so the repository holds nothing site-specific.

| Variable | Fallback | Meaning |
| --- | --- | --- |
| `BITBUCKET_URL` | `BB_URL` | Base URL, e.g. `https://bitbucket.example.com` |
| `BITBUCKET_USER` | `BB_USER` | Username |
| `BITBUCKET_TOKEN` | `BB_TOKEN` | Personal access token or app password |

`BITBUCKET_*` wins when both a `BITBUCKET_*` and a `BB_*` variable are set.

Register it with your MCP client, for example:

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "node",
      "args": ["/path/to/bitbucket-mcp/index.js"]
    }
  }
}
```

The client passes the `BITBUCKET_*` variables through from its own environment.

## Tools

| Tool | What it does |
| --- | --- |
| `bitbucket_list_pull_requests` | List PRs; optional state and page size |
| `bitbucket_get_pull_request` | Read one PR by id |
| `bitbucket_get_merge_status` | `canMerge`, `conflicted`, and veto reasons |
| `bitbucket_get_activities` | The PR discussion thread |
| `bitbucket_get_blocker_comments` | Tasks on the PR with their state and ids |
| `bitbucket_add_comment` | Post a comment; thread it with `parentId` |
| `bitbucket_resolve_task` | Resolve a task by its comment id |
| `bitbucket_set_draft` | Turn the draft flag on or off |
| `bitbucket_merge_pull_request` | Merge the PR; needs `confirm:true` |

### Safety

- `bitbucket_merge_pull_request` refuses unless `confirm:true` is passed, and
  merging is irreversible.
- `bitbucket_set_draft` re-sends the title, description and full reviewer list
  on the PUT that Bitbucket requires, because a Bitbucket PUT replaces the whole
  resource and would otherwise drop the reviewers.

## Development

```bash
npm install
npm test      # node --test, no network — fetch is injected
npm run gate  # lint + coverage
```

Every network function takes an injectable `fetchImpl`, so the tests never make
a real request and no fixtures carry real data.
