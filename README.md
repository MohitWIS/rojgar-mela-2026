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
| `providersReport` | `All_Details` | employer records |
| `providerNameField` | `Organization_Name` | the employer name column |
| `applicationForm` | `Apply_For_Job` | applications are created here |
| `applicationsReport` | `Apply_For_Job_Report` | the resume uploads here — a report, not a form |

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
`{ zc_display_value, ID }`, and what the display value holds varies — it may
be the Creator record ID, the provider's own code (`ORG-008`), or the
organisation name. There is no way to tell which by looking at it, so the
widget always fetches `All_Details` and indexes providers under **both** the
record ID and the `Provider_ID` code, then joins on whichever matches. A job
whose reference matches nothing keeps what the lookup gave it.

### Submitting an application

Two calls, because a File upload field cannot be set through `addRecords`:

1. `DATA.addRecords` → `Apply_For_Job` with `Organization_Name`, `Job_Title`,
   `Name`, `Contact_Number`, `Email`
2. `FILE.uploadFile` → `Apply_For_Job_Report` with the new record's ID and
   `Upload_Resume`

`Job_Title` and `Organization_Name` are **lookups**, into `Job_Openings` and
the provider form respectively. A lookup is written by sending the referenced
record's **ID**, not its display text — so the submit payload carries
`jobId` and `employerId`, and the readable strings are used only in the
confirmation message. When a job has no provider reference the lookup is
omitted rather than filled with text, which would store a dangling
reference. `APPLICATION_LOOKUP_FIELDS` in `data.js` is the list.

Those link names are pinned in `APPLICATION_FIELD_MAP` and are used whatever
`META.getFields` reports, so a failed metadata call cannot block a
submission. If `Name` turns out to be a Creator *Name* field (composite
first/last) rather than plain text, the first write fails and is retried once
with `{ first_name, last_name }` — set `applicantNameIsNameField: true` to
skip straight to that.

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
- [x] Pincode filter, cascading with the state filter
- [x] Apply modal — name, mobile, email and resume — saving to
      `Apply_For_Job` / `Apply_For_Job_Report`
- [ ] Confirm whether `Monthly_Salary_*_years` are monthly or annual; cards
      currently label them "per month"
