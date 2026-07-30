# farepool-jaipur

Pooling services for Jaipur.

FarePool compares scheduled ride estimates from **Ola**, **Uber**, and **Rapido**, then lets people schedule a shared cab on the same route. It is intentionally for **scheduled pooling only**, not instant/live pooling.

## Project files

| File or folder | What it does |
| --- | --- |
| `index.html` | The visible website page. |
| `styles.css` | Colours, layout, and mobile design. |
| `app.js` | Buttons, searches, price cards, and pool form. |
| `server.js` | The backend: saves pools and provides prices/pool data to the page. |
| `data/pools.json` | Saved example pools and newly created pools. |
| `package.json` | Tells Node.js how to start the backend. |
| `start-demo.bat` | The easiest way to run the project on Windows. |
| `.env.example` | Safe place to list future provider API keys. |

## Jaipur route map

The map starts in Jaipur. Select **Pin pickup**, click a place on the map, then select **Pin drop point** and click again. FarePool draws a route between the pins and adds the selected places to the pool form.

When a pool has a pinned route, a person can join only if both of their pins are close to that route and their drop point comes after their pickup point. This supports middle stops such as Mansarovar → Civil Lines → Jaipur Junction.

The demo map uses OpenStreetMap and a public route service, so it needs an internet connection. For a large public launch, switch to a paid or approved map-routing provider because free public map services have usage limits.

## Run the demo

### Easiest option — works now

1. Double-click `start-demo.bat`.
2. Because Node.js is not installed on this computer, it will open the visual demo in your browser.
3. Search a route, compare prices, and create or join a pool.

In visual-demo mode, a refresh removes pools that you created. The sample pools remain.

### Full version — saves new pools

1. Install **Node.js LTS** from the official Node.js website. Use the standard installation options.
2. Close and reopen this project folder.
3. Double-click `start-demo.bat`.
4. A browser opens at `http://localhost:3000`.
5. Keep the black command window open while you are using FarePool. Close it to stop the app.

The full version saves every pool you create into `data/pools.json`.

## Live prices from Ola, Uber and Rapido

This project currently shows clearly marked **demo estimates**, not live prices. Real-time fares require official, approved API access from each provider, with credentials issued to your business. Publicly scraping the ride apps is unreliable and can violate their rules.

When you obtain approved API access, add the keys to a new `.env` file based on `.env.example`, then replace the `makeFares` function in `server.js` with the provider API calls. The backend reads `.env`; keep API keys only in the backend—never in `app.js` or `index.html`.

## What works today

- Fare comparison cards for Auto, Hatchback, Sedan, and SUV options from Ola, Uber and Rapido.
- The lowest fare is highlighted.
- Links open each provider’s official website.
- People can create a pool with a route, optional via-stops, scheduled departure time, and seats.
- People can join only when their pickup and drop point are on the pool route in the correct order. For example, a pool from Koramangala → Domlur → Indiranagar can accept Koramangala → Domlur passengers.
- People can join a pool; the available seat count reduces.
- With Node.js installed, pool data is saved by the backend.
