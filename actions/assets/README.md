# Provisioning screenshots

Drop the image referenced by `../PROVISIONING.md` here:

- **`da-config-permissions.png`** — a screenshot of a target org's `da.live/config` → **`permissions`** sheet
  showing an identity granted `write` on `CONFIG` and on content (`/ + **`). Example rows:

  | path | groups | actions | comments |
  |---|---|---|---|
  | `CONFIG` | `<identity>` | `write` | The ability to set configurations for an org. |
  | `/ + **` | `<identity>` | `write` | The ability to create content. |

Save the file exactly as `da-config-permissions.png` so the `![…](assets/da-config-permissions.png)` reference in
`PROVISIONING.md` resolves.
