# preview

Screenshots produced by `tools/preview.mjs`. They are renders of the plugin's
**own components**, not captures of the running app: the stylesheet is lifted out
of `lib/client.js` verbatim and injected into a stand-in shell (an 800px settings
dialog, or a 248px sidebar), coloured with `--dsw-*` values read from the running
DSH theme. See [DEVELOPMENT.md](../DEVELOPMENT.md#预览台) for what the bench can
and cannot show.

Each image is sized to its own content — the page reports its laid-out height and
the window is matched to it — so there is no empty canvas around the dialog or
beside the sidebar card.

The session rows above the sidebar card are invented filler (`RAIL_ROWS` in
`tools/preview.mjs`), never real conversation titles: these pages are committed
and published, and `test/tools.test.mjs` pins the list so a change is deliberate.

| Files | What they are |
|---|---|
| `usage.png`, `account.png`, `settings.png` | The three tabs of the settings page. Referenced by the README. |
| `foot.png`, `foot-collapsed.png` | The sidebar card, expanded and collapsed. |
| `cache-write-*.png` | The same five surfaces with a non-zero cache-write figure, rendered with `--cache-write=860000`. Only some providers report that number, so the default fixtures leave it at 0. |
| `tokens.css` | Cached `--dsw-*` definitions from the running shell, so the bench still renders when DSH is not running. |

The `.html` files next to them are regenerated on every run and are not
committed; `tokens.css` and the `.png` files above are.

## Not committed

`before-*.png` — the "before" half of a redesign, rendered from an earlier
`lib/client.js` with `--client=`. They are snapshots of a version that no longer
exists, so they stay on the machine that made them (`.gitignore`); the published
repository shows the current design and nothing older. They are still produced on
demand:

```bash
node tools/preview.mjs --client=<path to an older lib/client.js> --tag=before-x
```

