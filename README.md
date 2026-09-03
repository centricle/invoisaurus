# Invoisaurus

Local invoice generator. Web UI in, PDF out.

Built to replace a hosted invoicing product whose UI was slow and whose site was
down during an actual billing attempt. Runs on your machine, stores plain JSON,
and generates the PDF you send to the client. No account, no network, no
database.

## Setup

Needs [Node](https://nodejs.org) 22 or newer. Nothing else.

```sh
npm install
npm run css:build
npm run dev
```

Then open <http://localhost:7054>.

The CSS build is not optional. The compiled stylesheet is generated rather than
committed, so a fresh clone that skips it runs fine but renders every page
unstyled.

## Design

**Your data is not in this repo.** The application reads and writes an external
directory (`INVOISAURUS_DATA_DIR`, default `./data`, gitignored). Keep it wherever
you like, back it up however you like. Nothing in it can be rebuilt from this
repo, so if that directory goes, the invoices go with it.

**Money is integer cents, quantities are integer thousandths.** JavaScript has
one number type and it stores fractions in binary. Decimal values like 0.1 have
no exact binary form, the same way 1/3 has no exact decimal form, so every
operation carries a small error: `0.1 + 0.2` evaluates to `0.30000000000000004`.
Round a column of those into a total and the invoice is off by a cent from the
sum the client adds up by hand. Integers have no such gap, so a rate of $150.00
is stored as `15000` and converted back to dollars only when it is printed.

**Invoices snapshot, they do not reference.** Each invoice freezes the vendor
and client details as they were when it was issued. Editing a client's address
never alters a past invoice, because an invoice is a record of what was sent.

**Invoice numbers are per-vendor.** The number is the issuing entity's book.
Each vendor carries its own prefix, padding and counter. Numbers are never
reused, including after a delete: a gap is a voided invoice, a duplicate is an
accounting problem.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `INVOISAURUS_DATA_DIR` | `./data` | Where records are read and written |
| `PORT` | `7054` | Port the server listens on |
| `NODE_ENV` | unset | `production` enables template caching |

All three are read at startup. To run against a different data directory on a
different port:

```sh
INVOISAURUS_DATA_DIR=~/Documents/invoices PORT=3000 npm run dev
```

## Your data

The data directory holds three things:

```
vendors.json              one entry per issuing entity
clients.json              one entry per client
invoices/ACM-0001.json    one file per invoice
```

Plain JSON, one record per file for invoices, human-readable and greppable
without the app. Writes are atomic (temp file plus rename), so an interrupted
save cannot leave a half-written invoice.

Backing it up is up to you. Nothing about the app cares how, or whether.

## Tests

```sh
npm test
```

68 tests on Node's built-in runner. No test dependencies, no config, no watch
mode to learn. They use temporary directories and never touch your data.

`test/routes.test.js` runs the real Express app against a temporary data
directory on an ephemeral port, so the request handlers are covered too, not
just the pure functions underneath them.

`.github/workflows/test.yml` runs the same command on pushes to `main` and on
every pull request, against the Node version pinned in `.nvmrc`.

## Project layout

| Path | Purpose |
|---|---|
| `server.js` | Express entry, mounts routes |
| `src/config.js` | Resolves the data directory, port and project root |
| `src/schema.js` | Record shapes and validation. The single definition of the data model. |
| `src/store.js` | JSON read/write, atomic writes, invoice number allocation |
| `src/money.js` | Integer-cent arithmetic and formatting |
| `src/lib/pdf/` | `layout.js` decides where things go, `generate.js` draws them |
| `src/routes/` | One router each for invoices, clients, vendors |
| `src/views/` | EJS templates |
| `public/js/` | Browser-side behavior for the invoice editor |

Express 5, EJS, Tailwind 4 via the CLI, pdf-lib. Line-item arithmetic is vanilla
JS in the browser; everything else is a form POST. No bundler, no client
framework, three runtime dependencies.

## License

MIT
