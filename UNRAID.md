# ReelKeeper on Unraid

## Docker Compose Manager

1. Extract the ReelKeeper release folder onto the server, for example at `/mnt/user/appdata/reelkeeper-app`.
2. Open a terminal in that folder.
3. Run `docker compose up --build -d`.
4. Open `http://YOUR-UNRAID-IP:3000`.

Inventory is persisted in the release folder's `data/reelkeeper.json` file. Back up the `data` folder with the rest of your appdata.

To use a different host port, create a `.env` file beside `docker-compose.yml` containing:

```text
REELKEEPER_PORT=3010
```

Then run `docker compose up --build -d` again.

## Common commands

```bash
docker compose up --build -d
docker compose logs -f reelkeeper
docker compose restart reelkeeper
docker compose down
```

The included `ReelKeeper-logo.png` is a 512 x 512 icon suitable for the Unraid Docker interface.

## Docker icon

The Compose file includes an Unraid icon label that uses the public GitHub-hosted PNG.

If an existing container still shows the default icon, edit the ReelKeeper container in Unraid, enable Advanced View, and set its Icon URL to:

```text
https://raw.githubusercontent.com/Nick-116/ReelKeeper/main/public/ReelKeeper-logo.png
```

Apply the container update and refresh the Docker page.
