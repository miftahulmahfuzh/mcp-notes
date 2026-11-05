# notesd feature map

What notesd does, from the user's side, and what proves each feature works. One file per
feature, each with the same four sections: `Sub-features`, `How to get to it (user POV)`,
`Driving it with verify.sh`, `Gotchas`. A plan's **Proof** section cites entries by file name.

| Feature | File | Surfaces |
| --- | --- | --- |
| Notes: create, edit, append, tags, revisions, soft delete | [notes.md](notes.md) | API, MCP, wall |
| Search and related notes | [search.md](search.md) | MCP, chat |
| Photos and files in notes | [images-files.md](images-files.md) | API upload, MCP, wall, inbox folder |
| Recycle bin (restore, delete forever) | [recycle-bin.md](recycle-bin.md) | API, wall |
| The wall: live updates, editor, sidebar | [wall.md](wall.md) | wall |
| Projects: Claude Code session graph | [projects.md](projects.md) | API, MCP, wall `/projects` |
| Chat bar and chat history | [chat.md](chat.md) | wall, API (billed) |
| Seer Adversarial: reviewer, verdicts in Seer, toggle, budget | [adversary.md](adversary.md) | background job (`up --adversary`), Seer DB |

Add an entry when a change ships a new user-facing feature; fix an entry when the app's behavior
changed on purpose. A journey that fails because the app is broken is a product bug: report it,
do not edit the entry to match.
