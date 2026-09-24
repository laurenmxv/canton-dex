# Canton DEX login theme

The `canton-dex` theme extends the bundled Keycloak 26.1 login theme. Registration,
sign-in and validation use Keycloak's original forms; only presentation changes.
`make docker-run` assigns the theme to the `dex-web` client.

Compose mounts two of the frontend's directories into the theme, so the login
and the app show one palette and one venue logo:

| Host directory | Theme path | Read by |
|---|---|---|
| `frontend/src/styles` | `resources/shared` | `shared/tokens.css`, in `theme.properties` |
| `frontend/src/assets` | `resources/img` | `../img/venue-mark.svg`, in `css/dex.css` |

Both are directory mounts, and must stay that way. A tool that saves a file by
writing a new one and renaming it over the old gives that path a new inode. A
mount of the file itself keeps pointing at the inode that is gone, and Keycloak
then answers HTTP 500 for a stylesheet that is present on the host. A mount of
the directory follows the rename.

`resources/shared` and `resources/img` hold a `.gitkeep` so the mount point
stays in the repository. Do not put a stylesheet in either one: the frontend
owns what they carry. Keycloak follows the system's light/dark preference.

After changing theme resources, restart Keycloak and refresh the page:

```sh
docker compose -f docker/compose.dev.yaml restart keycloak
```
