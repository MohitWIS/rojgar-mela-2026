# Rojgar — NSDC job board widget

A Zoho Creator widget that lists job openings as cards and lets a candidate
apply with their details and a resume.

Built with the Zoho Extension Toolkit (ZET). Reads live data through the
Creator **JS API v2** (`ZOHO.CREATOR.DATA` / `META` / `FILE`).

## Layout

```
app/
  widget.html          markup shell
  css/tokens.css       design tokens — every colour, space and radius
  css/base.css         reset and utilities
  css/widget.css       layout and components
  js/data.js           everything Creator-shaped: fetching, field mapping
  js/widget.js         rendering, filtering, the apply modal
server/index.js        ZET local dev server (Zoho's, unmodified)
plugin-manifest.json   extension manifest
```

`widget.js` only ever calls `RojgarAPI.listJobs()` and
`RojgarAPI.submitApplication()`. Everything Creator-specific lives in
`data.js`.

## Creator configuration

Set at the top of [`app/js/data.js`](app/js/data.js):

| Key | Value | Notes |
| --- | --- | --- |
| `appName` | `rojgar-mela-2026` | application link name |
| `jobsForm` | `Job_Openings` | used by `META.getFields` for field metadata |
| `jobsReport` | `All_Job_Openings` | the records |
| `jobsCriteria` | *(empty)* | a criteria naming a missing field is a hard error |
| `providersReport` | *(auto)* | discovered from the app's report list |
| `applicationForm` | **unset** | required before Apply works |
| `applicationsReport` | **unset** | required — uploads target a report, not a form |
| `resumeField` | `Resume` | the File upload field's link name |

### Field mapping

Job field link names are resolved at runtime — by link name then display
name, exactly, then normalised, then by containment (which is what makes
`Monthly_Salary_Min` match the actual `Monthly_Salary_Min_years`). The
resolved mapping is logged on every load:

```
[Rojgar] field mapping { title: 'Job_Title', employer: 'Provider_ID', ... }
```

To pin a field and stop the guessing, add it to `FIELD_MAP`.

### Employer names

The employer is a `Provider_ID` lookup. Creator returns a lookup as
`{ zc_display_value, ID }`, and the display value is frequently just the ID
again — so the widget fetches the providers report and joins
`Organization_Name` on ID. That second fetch is skipped when the lookup
already carries a real name.

## Running locally

```sh
npm install
npm start          # https://127.0.0.1:5000/app/widget.html
```

The TLS pair is **not in this repo** — `key.pem` is a private key. Generate a
self-signed localhost pair in the project root before the first run:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=127.0.0.1"
```

Then open the URL once and accept the certificate
(*Advanced → Proceed to 127.0.0.1*), or Creator cannot load the widget.

### The dev server alone is not enough

Every v2 call is a `postMessage` to Creator's parent frame, so opening
`widget.html` directly shows a "Couldn't load jobs" panel by design. To see
live data, register the widget in Creator pointing at the dev-server URL, or
`zet pack` and install it.

## Status

- [x] Job cards from `All_Job_Openings`, paged past 1000 via `record_cursor`
- [x] Employer names joined through the `Provider_ID` lookup
- [x] Search, employment-type filter, state filter, sorting
- [x] Apply modal with validation and resume upload (PDF/DOC/DOCX, 5 MB)
- [ ] Application form/report link names — Apply reports a clear error until set
- [ ] Confirm whether `Monthly_Salary_*_years` are monthly or annual; cards
      currently label them "per month"
