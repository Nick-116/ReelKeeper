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
- Export OpenPnP `parts.xml` and `packages.xml` files or an additive library-import script. Part IDs use readable names, category prefixes, and LCSC or Mouser numbers so similar components remain distinguishable.
- Retrieve exact package pad geometry from EasyEDA using LCSC numbers, preview footprints before approval, and manually map uncertain components to known packages already in the library.
- Assign ReelKeeper nozzle sizes to OpenPnP packages. The import script can map those sizes to the nozzle-tip names configured on your machine and apply compatible nozzle tips automatically.
- Store component heights for OpenPnP using datasheet dimensions, package defaults, or manual review. Datasheets are downloaded with component data and available in the built-in review viewer.
- Use the authenticated AI Part Review API to review only components missing verified heights and submit evidence-backed results without embedding AI in ReelKeeper.
- Upload a board BOM and export an OpenPnP assignment script that connects every designator to an existing library part by LCSC number. Missing parts, missing LCSC numbers, and conflicting designators are reported before download.
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
- `GET /api/export/openpnp/import-script.js`
- `POST /api/export/openpnp/bom-assignment-script`
- `POST /api/openpnp/footprints/fetch`
- `GET /api/openpnp/packages/known`
- `POST /api/openpnp/packages/assign`
- `GET /api/openpnp/nozzles`
- `POST /api/openpnp/nozzles/assign`
- `POST /api/openpnp/heights/review/start`
- `GET /api/height-review/pending` with a dedicated height-review API key
- `POST /api/height-review/:partId/result`
- `GET /api/docs`

The in-app Settings page includes copyable examples for order imports, BOM checks, and marking components as used.

## BOM compatibility rules

ReelKeeper marks exact LCSC or manufacturer part matches as compatible. For resistors, capacitors, and inductors, it can also substitute by inferred category, matching package, matching electrical value, and equal-or-higher voltage when voltage is known. For semiconductors, ICs, connectors, fuses, LEDs, switches, and modules, ReelKeeper requires an exact LCSC or manufacturer part match.
