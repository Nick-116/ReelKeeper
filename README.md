# ReelKeeper

ReelKeeper is a self-hosted SMD inventory tracker for component reels, cut tape, trays, and loose parts. It can import LCSC order CSVs, classify parts automatically, upload PCB software BOM `.xlsx` files, compare compatible parts against your stock, and expose an API for pick-and-place machines to decrement stock as parts are placed.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Run with Docker

```bash
git clone https://github.com/Nick-116/ReelKeeper.git
cd ReelKeeper
docker compose up --build
```

Inventory data is stored at `data/reelkeeper.json` through the mounted volume.

The Unraid icon URL is:

```text
https://raw.githubusercontent.com/Nick-116/ReelKeeper/main/public/ReelKeeper-logo.png
```

## API highlights

- `GET /api/parts`
- `POST /api/parts`
- `PATCH /api/parts/:id`
- `DELETE /api/parts/:id`
- `POST /api/import/order`
- `POST /api/bom/check`
- `POST /api/bom/upload`
- `POST /api/use` with an LCSC part number, MPN, or component id and the quantity used
- `GET /api/docs`

The in-app Settings page includes copyable examples for order imports, BOM checks, and marking components as used.

## BOM compatibility rules

ReelKeeper marks exact LCSC or manufacturer part matches as compatible. For resistors, capacitors, and inductors, it can also substitute by inferred category, matching package, matching electrical value, and equal-or-higher voltage when voltage is known. For semiconductors, ICs, connectors, fuses, LEDs, switches, and modules, ReelKeeper requires an exact LCSC or manufacturer part match.
