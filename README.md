# Invoisaurus

Local invoice generator. Web UI in, PDF out.

Built to replace a hosted invoicing product whose UI was slow and whose site was
down during an actual billing attempt. Runs on your machine, stores plain JSON,
and generates the PDF you send to the client. No account, no network, no
database. The server binds loopback only, so an editor with no login on it does
not appear on whatever network the machine has joined.

![The invoice editor: line items, live totals and a notes field](docs/editor.png)

Line-item arithmetic happens in the browser as you type. Everything else is a
form POST. The preview below the editor is not a second rendering of the same
data — it is an iframe pointed at the real PDF route, so what you see is the
file the client gets.

![The generated PDF: ACME Corporation billing Wile E. Coyote $695.00](docs/invoice-pdf.png)

## Quick start

Needs [Node](https://nodejs.org) 22.6 or newer. Nothing else.

```sh
git clone https://github.com/centricle/invoisaurus.git
cd invoisaurus
npm run setup
npm run dev
```

Then open <http://localhost:7054>.

`npm run setup` installs dependencies, builds the stylesheet, and seeds a demo
vendor, client and invoice so there is something to look at. It is safe to
re-run.

On Windows, or if you would rather not run the script, do the same three things
by hand, then start it:

```sh
npm install
npm run css:build
npm run seed
npm run dev
```

The CSS build is not optional. The compiled stylesheet is generated rather than
committed, so a fresh clone that skips it runs fine but renders every page
unstyled.

## Demo data

The seed creates three fictional records:

| Record | Value |
|---|---|
| Vendor | ACME Corporation, invoice prefix `ACM-` |
| Client | Wile E. Coyote |
| Invoice | `ACM-0001`, draft, $695.00 |

**Removing them:**

```sh
npm run seed -- --remove
```

That clears the vendor, the client and the invoice, leaving an empty data
directory ready for your own records. It refuses to run if the directory
contains anything that is not demo data, so it cannot eat real invoices. If it
refuses, delete the demo records by hand or point `INVOISAURUS_DATA_DIR` somewhere
new.

You can also just delete the data directory. The app recreates it empty on the
next start, so that is a clean slate rather than a repair.

One thing worth knowing before you start numbering for real: **invoice numbers
are never reused within a vendor's lifetime.** Delete `ACM-0003` and the next
invoice is still `ACM-0004`. A gap in the series is a voided invoice; a
duplicate is an accounting problem. Removing the demo vendor entirely does reset
the counter, because the counter lives on the vendor record.

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
Each vendor carries its own prefix, padding and counter.

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

If an invoice file will not parse anyway, the list names it and marks it
unreadable rather than either hiding it or refusing to render. One damaged file
should not conceal the other two hundred, and an invoice that quietly stops
appearing is an invoice nobody chases. The two registry files are the
exception: they fail loudly, because every invoice on disk points into them.

Backing it up is up to you. `npm run data:commit` exists for one specific setup:
a data directory that is itself a git repo. It stages and commits everything in
one step. Point it at a directory that is not a repo and it commits nothing and
exits with an error saying how to initialize one. Any other backup approach, or
none, works the same as far as the app is concerned.

## Tests

```sh
npm test
```

101 tests on Node's built-in runner. No test dependencies, no config, no watch
mode to learn.

Every test file binds `INVOISAURUS_DATA_DIR` to a fresh temporary directory before
it loads anything from `src/`, so the suite cannot reach your records even by
accident. `test/routes.test.js` runs the real Express app against one of those
directories on an ephemeral port, so the request handlers are covered too, not
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
| `public/js/` | Browser-side behavior: the invoice editor, and the number steppers every form uses |

Express 5, EJS, Tailwind 4 via the CLI, pdf-lib. Line-item arithmetic is vanilla
JS in the browser; everything else is a form POST. No bundler, no client
framework, three runtime dependencies.

## License

[MIT](./LICENSE)
