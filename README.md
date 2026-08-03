# ReelKeeper

<p align="center">
  <img src="https://raw.githubusercontent.com/Nick-116/ReelKeeper/main/public/ReelKeeper-logo.png?v=2" alt="ReelKeeper circuit-board logo" width="180">
</p>

ReelKeeper is a self hosted inventory management software for PCB components. I have tons of different SMD and through hole components for my PCB projects, and they are difficult to keep track of, so I designed this.

## Features

- Add components manually, from an inventory template, an LCSC order CSV, or a Mouser order spreadsheet. LCSC imports can pull component photos and product information.
- Track machine-ready and loose stock separately, including splitting one order line between both packaging types.
- Search and filter the component library by category, value, voltage, package, packaging type, and other relevant component details.
- BOM checking: References your library to a bill of materials for a current project. It will do its best to match components that fit the bill, not specific to brands. For example it will choose any capacitor that is over 12v, is 0805, etc..
- Save manual BOM matches, export the remaining parts to order, and estimate the component cost per board using updated LCSC or imported Mouser pricing.
- Export OpenPnP `parts.xml` and `packages.xml` files or an additive import script. ReelKeeper can retrieve exact pad geometry from EasyEDA using LCSC part numbers, show a footprint preview for approval, and report components that still need review.
- Upload a board BOM and export an OpenPnP script that assigns existing library parts to board designators by LCSC part number.
- Review missing OpenPnP component heights manually from stored datasheets, or use the authenticated AI Part Review API to submit evidence-backed heights without embedding AI in ReelKeeper.
- Undo order imports, review inventory activity in the audit log, and reset the installation from Settings.
- Full API: I added this so I could have my pick and place automatically adjust my database every time it places a component. If you are interested in the scripts for that send me a message! It is all documented in the settings>API page.

## Screenshots

### Component library

![ReelKeeper component library](docs/images/components.png)

### BOM checking

![ReelKeeper BOM checker](docs/images/bom-check.png)

### Adding inventory

![ReelKeeper inventory import options](docs/images/add-inventory.png)

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

## API highlights

- `GET /api/parts`
- `POST /api/parts`
- `PATCH /api/parts/:id`
- `DELETE /api/parts/:id`
- `POST /api/import/order`
- `POST /api/bom/check`
- `POST /api/bom/upload`
- `POST /api/use` with an LCSC part number, MPN, or component id and the quantity used
- `GET /api/export/openpnp/parts.xml`
- `GET /api/export/openpnp/packages.xml`
- `POST /api/openpnp/footprints/fetch`
- `GET /api/height-review/pending` with a dedicated height-review API key
- `POST /api/height-review/:partId/result`
- `GET /api/docs`

The in-app Settings page includes copyable examples for order imports, BOM checks, and marking components as used.

## BOM compatibility rules

ReelKeeper marks exact LCSC or manufacturer part matches as compatible. For resistors, capacitors, and inductors, it can also substitute by inferred category, matching package, matching electrical value, and equal-or-higher voltage when voltage is known. For semiconductors, ICs, connectors, fuses, LEDs, switches, and modules, ReelKeeper requires an exact LCSC or manufacturer part match.
