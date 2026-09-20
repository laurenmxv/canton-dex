# Canton DEX login theme

The `canton-dex` theme extends the bundled Keycloak 26.1 login theme. Registration,
sign-in and validation use Keycloak's original forms; only presentation changes.
`make docker-run` assigns the theme to the `dex-web` client.

Compose mounts the frontend's `src/styles/tokens.css` and `src/assets` into the
theme so both pages use the same palette and venue logo. The checked-in
`resources/css/tokens.css` file is a mount point. Keycloak follows the system's
light/dark preference.

After changing theme resources, restart Keycloak and refresh the page:

```sh
docker compose restart keycloak
```
