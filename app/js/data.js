/* ==========================================================================
   Rojgar — Data layer (live Zoho Creator data)
   --------------------------------------------------------------------------
   Written against JS API v2 (the `version/2.0` SDK loaded in widget.html),
   whose config keys are snake_case: app_name / form_name / report_name.

   The UI in widget.js only ever calls RojgarAPI.listJobs() and
   .submitApplication(); everything Creator-shaped is contained here.
   ========================================================================== */

/* --------------------------------------------------------------------------
   1. Creator wiring
   --------------------------------------------------------------------------
   Jobs need BOTH names: the report is what records are read from, the form
   is what field metadata is read from (META.getFields takes a form).

   jobsCriteria is empty on purpose — a criteria naming a field the report
   does not have is a hard error, not an empty result. Add one once the
   field names are confirmed, e.g. 'Status == "Open"'.
   -------------------------------------------------------------------------- */
var CREATOR = {
  appName: 'rojgar-mela-2026',
  jobsForm: 'Job_Openings',
  jobsReport: 'All_Job_Openings',
  jobsCriteria: '',

  /* Employer name lives on the record the Provider_ID lookup points at, not
     on the job. Creator returns a lookup as { zc_display_value, ID } and
     zc_display_value is frequently just the ID again, so the name has to be
     fetched separately and joined on ID.

     Leave providersReport blank to have it discovered from the app's report
     list (first match on provider / employer / organisation); set it to skip
     that lookup. Same for providerNameField, resolved against the aliases
     in PROVIDER_NAME_ALIASES. */
  providersReport: '',
  providerNameField: '',

  applicationForm: '',        // TODO: form link name that stores an application
  applicationsReport: '',     // TODO: a report over that same form
  resumeField: 'Resume'       // TODO: the File upload field's link name
};

/* --------------------------------------------------------------------------
   2. Field mapping
   --------------------------------------------------------------------------
   FIELD_MAP is the explicit override — put real link names here and matching
   stops guessing. Anything left out is resolved at runtime against the form's
   actual metadata, by link name then display name, exactly and then
   normalised ("Job Title", "job_title" and "JobTitle" all collapse to
   "jobtitle"). The resolved mapping is logged to the console on every load.
   -------------------------------------------------------------------------- */
var FIELD_MAP = {
  salaryMin: 'Monthly_Salary_Min_years',
  salaryMax: 'Monthly_Salary_Max_years'
};

var FIELD_ALIASES = {
  title: ['Job_Title', 'Job_Role', 'Job_Name', 'Role', 'Position', 'Designation', 'Title'],
  /* Provider_ID first: on this app the employer is a lookup, so the job
     record carries a reference rather than a name. The later ones cover a
     plain-text employer column if one is ever added. */
  employer: ['Provider_ID', 'Provider', 'Employer_ID', 'Employer_Name', 'Employer',
             'Company_Name', 'Company', 'Organisation', 'Organization',
             'Hiring_Company'],
  sector: ['Sector', 'Industry', 'Job_Sector', 'Category', 'Domain'],
  /* The address is spread over five columns, so each is resolved separately
     and recombined in mapRecordToJob. `location` is the short label the card
     leads with and the search matches first. */
  location: ['Location_Name', 'Job_Location', 'Location', 'Work_Location',
             'City', 'Place', 'District'],
  addressLine1: ['Physical_Address_Line_1', 'Address_Line_1', 'Address_Line1',
                 'Street_Address', 'Address'],
  addressState: ['Physical_Address_State', 'Address_State', 'State'],
  addressCountry: ['Physical_Address_Country', 'Address_Country', 'Country'],
  addressPin: ['Physical_Address_Pin_Code', 'Address_Pin_Code', 'Pin_Code',
               'Pincode', 'Postal_Code', 'Zip_Code'],
  type: ['Employment_Type', 'Job_Type', 'Type_of_Employment', 'Type', 'Employment'],
  salaryMin: ['Salary_Min', 'Min_Salary', 'Minimum_Salary', 'Salary_From',
              'Monthly_Salary_Min', 'Salary_Range_From'],
  salaryMax: ['Salary_Max', 'Max_Salary', 'Maximum_Salary', 'Salary_To',
              'Monthly_Salary_Max', 'Salary_Range_To'],
  salary: ['Salary', 'Monthly_Salary', 'Pay', 'CTC', 'Stipend', 'Salary_Offered'],
  experience: ['Experience_Required', 'Experience', 'Work_Experience', 'Exp_Required'],
  qualification: ['Minimum_Qualification', 'Qualification', 'Education',
                  'Educational_Qualification', 'Min_Qualification'],
  openings: ['Number_of_Openings', 'No_of_Openings', 'Openings', 'Vacancies',
             'No_of_Vacancies', 'Positions'],
  description: ['Job_Description', 'Description', 'Job_Details', 'Details',
                'About_the_Role', 'Roles_and_Responsibilities'],
  skills: ['Key_Skills', 'Skills', 'Required_Skills', 'Skill_Set'],
  posted: ['Posted_On', 'Posted_Date', 'Date_Posted', 'Added_On', 'Created_On',
           'Job_Posted_On'],
  closes: ['Last_Date_to_Apply', 'Last_Date', 'Closing_Date', 'Apply_By',
           'Application_Deadline', 'Valid_Till'],
  priority: ['Priority', 'Urgency', 'Is_Urgent']
};

/* The employer name on the record Provider_ID points at. */
var PROVIDER_NAME_ALIASES = [
  'Organization_Name', 'Organisation_Name', 'Org_Name', 'Provider_Name',
  'Company_Name', 'Employer_Name', 'Training_Partner_Name', 'Name'
];

/* Without these two a card has nothing to say, so they are fatal. */
var REQUIRED_FIELDS = ['title', 'employer'];

/* Not worth warning about when absent — both are optional enhancements. */
var OPTIONAL_FIELDS = ['salary', 'priority'];

/* Shortest alias allowed to match by containment. Below this, generic words
   ("Type", "Name", "Role", "Salary") start binding to the wrong column. */
var MIN_FUZZY_LENGTH = 8;

/* ==========================================================================
   RojgarAPI
   ========================================================================== */
var RojgarAPI = (function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Environment
     ------------------------------------------------------------------------
     The SDK script loads perfectly well outside Creator — it is just a file
     on a CDN — so the presence of ZOHO.CREATOR proves nothing on its own.
     Every v2 call is a postMessage to the parent window, and without one the
     SDK throws "Parentwindow reference not found". Hence the frame test.     */
  function inCreatorFrame() {
    try {
      return !!window.parent && window.parent !== window;
    } catch (e) {
      // A cross-origin parent throws on access, which means we ARE framed.
      return true;
    }
  }

  function hasCreator() {
    return typeof ZOHO !== 'undefined' &&
      ZOHO.CREATOR &&
      ZOHO.CREATOR.DATA &&
      typeof ZOHO.CREATOR.DATA.getRecords === 'function' &&
      inCreatorFrame();
  }

  /* JS API v2 has no ZOHO.CREATOR.init() — that belonged to v1, and calling
     it throws a synchronous TypeError. Nothing needs initialising in v2. */
  function init() {
    return Promise.resolve(hasCreator());
  }

  /* No v2 call should be able to hang the UI on a lost parent frame. */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error(label + ' timed out after ' + (ms / 1000) + 's'));
        }, ms);
      })
    ]);
  }

  /* Every v2 call resolves with { code, ... }. Only 3000 means success — a
     failure still RESOLVES, so it must be checked rather than left to catch.
     `key` differs by namespace: DATA answers under `data`, META under
     `fields`. */
  function unwrap(response, what, key) {
    if (!response || response.code !== 3000) {
      var detail = (response && (response.message || response.description)) ||
        ('code ' + (response && response.code));
      throw new Error(what + ' failed — ' + detail);
    }
    return response[key || 'data'];
  }

  /* ------------------------------------------------------------------------
     Value coercion — Creator returns several shapes per field type
     ------------------------------------------------------------------------ */

  /* Lookups, dropdowns and Name fields arrive as objects carrying
     display_value; plain text arrives as a string; multi-selects as arrays. */
  function text(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');

    if (typeof value === 'object') {
      if (value.display_value) return String(value.display_value);
      if (value.zc_display_value) return String(value.zc_display_value);
      var parts = [value.first_name, value.last_name].filter(Boolean);
      return parts.length ? parts.join(' ') : '';
    }
    return String(value);
  }

  /* Currency and number fields can arrive as "18,000.00" or as 18000. */
  function num(value) {
    var parsed = parseFloat(String(text(value)).replace(/[^0-9.\-]/g, ''));
    return isNaN(parsed) ? 0 : parsed;
  }

  /* Drops empty segments so a missing address line never leaves ", ," behind. */
  function joinParts(parts, separator) {
    return parts.filter(function (p) { return p && String(p).trim(); })
      .map(function (p) { return String(p).trim(); })
      .join(separator || ', ');
  }

  function list(value) {
    if (Array.isArray(value)) return value.map(text).filter(Boolean);
    return String(text(value)).split(',').map(function (s) {
      return s.trim();
    }).filter(Boolean);
  }

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* Creator formats dates per the application's locale; the UI works in ISO,
     so everything is normalised here. dd-MMM-yyyy is Creator's default. For
     all-numeric dates the day is assumed first, the Indian convention — if
     the app is set to MM/dd/yyyy, swap the last branch. */
  function toISODate(value) {
    var raw = text(value).trim();
    if (!raw) return '';

    var datePart = raw.split(' ')[0];
    var m;

    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(datePart);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);

    m = /^(\d{1,2})[-\/]([A-Za-z]{3,})[-\/](\d{4})$/.exec(datePart);
    if (m) {
      var mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return m[3] + '-' + pad(mo) + '-' + pad(+m[1]);
    }

    m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/.exec(datePart);
    if (m) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);

    return '';
  }

  /* ------------------------------------------------------------------------
     Field resolution
     ------------------------------------------------------------------------ */

  function normalise(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* Reads the form's field metadata. Resolves to [] rather than rejecting:
     a missing metadata call should degrade to record-key matching, not stop
     the jobs loading. */
  function describeForm() {
    if (!ZOHO.CREATOR.META || typeof ZOHO.CREATOR.META.getFields !== 'function') {
      return Promise.resolve([]);
    }
    return withTimeout(ZOHO.CREATOR.META.getFields({
      app_name: CREATOR.appName,
      form_name: CREATOR.jobsForm
    }), 15000, 'Reading form fields').then(function (response) {
      // META answers under `fields`, not `data`.
      return unwrap(response, 'Reading form fields', 'fields') || [];
    })['catch'](function () {
      return [];
    });
  }

  /* Builds { logical: actualLinkName } from the form metadata, falling back
     to the keys actually present on a returned record. */
  function buildFieldIndex(formFields, sampleRecord) {
    var byLink = {};
    var byDisplay = {};
    var known = [];

    (formFields || []).forEach(function (f) {
      if (!f || !f.link_name) return;
      byLink[normalise(f.link_name)] = f.link_name;
      if (f.display_name) byDisplay[normalise(f.display_name)] = f.link_name;
      known.push(f.link_name);
    });

    // Record keys are the fallback source, and the authority on what the
    // report actually returns — a form field absent from the record is of
    // no use to us.
    var recordKeys = sampleRecord ? Object.keys(sampleRecord) : [];
    var byRecord = {};
    recordKeys.forEach(function (k) { byRecord[normalise(k)] = k; });

    function present(name) {
      if (!name) return null;
      if (!sampleRecord) return name;
      return sampleRecord.hasOwnProperty(name) ? name : byRecord[normalise(name)] || null;
    }

    var resolved = {};

    function candidatesFor(logical) {
      var out = FIELD_MAP[logical] ? [FIELD_MAP[logical]] : [];
      return out.concat(FIELD_ALIASES[logical]);
    }

    /* Pass 1 — exact, then normalised-exact, against record keys, link names
       and display names. */
    Object.keys(FIELD_ALIASES).forEach(function (logical) {
      var candidates = candidatesFor(logical);

      for (var i = 0; i < candidates.length; i++) {
        var n = normalise(candidates[i]);
        var hit = present(candidates[i]) ||
                  present(byLink[n]) ||
                  present(byDisplay[n]) ||
                  present(byRecord[n]);
        if (hit) { resolved[logical] = hit; return; }
      }
    });

    /* Pass 2 — containment, for names that merely EXTEND an alias:
       "Monthly_Salary_Min" vs the actual "Monthly_Salary_Min_years". Exact
       matching misses these entirely and the field silently reads as empty.

       Guarded three ways: a minimum alias length, so short aliases like
       "Type" or "Name" cannot grab an unrelated column; a claim list, so two
       logical fields never bind to the same column; and a preference for the
       shortest match, which is the one closest to the alias. */
    var claimed = {};
    Object.keys(resolved).forEach(function (k) { claimed[resolved[k]] = true; });

    Object.keys(FIELD_ALIASES).forEach(function (logical) {
      if (resolved[logical]) return;

      var best = null;
      var bestLength = Infinity;

      candidatesFor(logical).forEach(function (alias) {
        var a = normalise(alias);
        if (a.length < MIN_FUZZY_LENGTH) return;

        recordKeys.forEach(function (key) {
          if (claimed[key]) return;
          var k = normalise(key);
          if (k.indexOf(a) === -1 && a.indexOf(k) === -1) return;
          if (k.length < bestLength) { best = key; bestLength = k.length; }
        });
      });

      if (best) {
        resolved[logical] = best;
        claimed[best] = true;
        if (window.console && console.info) {
          console.info('[Rojgar] "' + logical + '" matched loosely to "' + best + '"');
        }
      }
    });

    return {
      map: resolved,
      formFields: known,
      recordKeys: recordKeys
    };
  }

  function get(record, index, logical) {
    var key = index.map[logical];
    return key ? record[key] : undefined;
  }

  /* ------------------------------------------------------------------------
     Lookups
     ------------------------------------------------------------------------
     Creator returns a lookup as { zc_display_value, ID }. The display value
     is whatever the lookup is configured to show, which is often the record
     ID — so it can never be trusted as a name without checking.            */

  function lookupId(value) {
    if (Array.isArray(value)) value = value[0];
    if (value && typeof value === 'object') return String(value.ID || '');
    return '';
  }

  /* A Creator record ID is a long digit string. If the "name" is that, the
     lookup is displaying its ID and we have to go and fetch the real one. */
  function looksLikeRecordId(value) {
    return /^\d{6,}$/.test(String(value || '').trim());
  }

  /* Finds the report holding provider records, preferring an explicit
     setting and otherwise matching the app's report list by name. */
  function findProvidersReport() {
    if (CREATOR.providersReport) return Promise.resolve(CREATOR.providersReport);

    if (!ZOHO.CREATOR.META || typeof ZOHO.CREATOR.META.getReports !== 'function') {
      return Promise.resolve('');
    }

    return withTimeout(
      ZOHO.CREATOR.META.getReports({ app_name: CREATOR.appName }),
      15000, 'Reading report list'
    ).then(function (response) {
      var reports = unwrap(response, 'Reading report list', 'reports') || [];
      var patterns = [/provider/i, /employer/i, /organi[sz]ation/i, /company/i];

      for (var p = 0; p < patterns.length; p++) {
        for (var i = 0; i < reports.length; i++) {
          var r = reports[i];
          if (!r || !r.link_name) continue;
          if (patterns[p].test(r.link_name) || patterns[p].test(r.display_name || '')) {
            return r.link_name;
          }
        }
      }
      return '';
    })['catch'](function () { return ''; });
  }

  /* Builds { providerRecordId: organisationName }. */
  function loadProviderNames(reportName) {
    return withTimeout(ZOHO.CREATOR.DATA.getRecords({
      app_name: CREATOR.appName,
      report_name: reportName,
      field_config: 'all',
      max_records: 1000
    }), 20000, 'Loading employers').then(function (response) {
      if (response && response.code === 3100) return {};
      var rows = unwrap(response, 'Loading employers') || [];
      if (!rows.length) return {};

      // Resolve which column carries the name, once.
      var nameField = CREATOR.providerNameField;
      if (!nameField) {
        var keys = Object.keys(rows[0]);
        var byNorm = {};
        keys.forEach(function (k) { byNorm[normalise(k)] = k; });

        for (var i = 0; i < PROVIDER_NAME_ALIASES.length; i++) {
          var hit = rows[0].hasOwnProperty(PROVIDER_NAME_ALIASES[i])
            ? PROVIDER_NAME_ALIASES[i]
            : byNorm[normalise(PROVIDER_NAME_ALIASES[i])];
          if (hit) { nameField = hit; break; }
        }
      }

      if (!nameField) return {};

      if (window.console && console.info) {
        console.info('[Rojgar] employer names from ' + reportName + '.' + nameField);
      }

      var names = {};
      rows.forEach(function (r) {
        if (r.ID) names[String(r.ID)] = text(r[nameField]);
      });
      return names;
    })['catch'](function (error) {
      if (window.console) console.warn('[Rojgar] employer lookup failed', error);
      return {};
    });
  }

  /* Fills in job.employer from the provider records, but only when the
     lookup did not already hand us a usable name — that check saves a whole
     extra report fetch on apps where the lookup displays the org name. */
  function resolveEmployers(jobs) {
    var needsJoin = jobs.some(function (j) {
      return j.employerId && (!j.employer || looksLikeRecordId(j.employer));
    });

    if (!needsJoin) return Promise.resolve(false);

    return findProvidersReport().then(function (reportName) {
      if (!reportName) return false;
      return loadProviderNames(reportName).then(function (names) {
        var matched = 0;
        jobs.forEach(function (job) {
          var name = names[job.employerId];
          if (name) { job.employer = name; matched++; }
          else if (looksLikeRecordId(job.employer)) job.employer = '—';
        });
        return matched > 0;
      });
    });
  }

  function mapRecordToJob(record, index) {
    var minSalary = num(get(record, index, 'salaryMin'));
    var maxSalary = num(get(record, index, 'salaryMax'));

    // A single "Salary" field stands in when there is no min/max pair.
    if (!minSalary && !maxSalary) minSalary = num(get(record, index, 'salary'));

    /* employer is a lookup here, so keep the referenced record's ID — the
       readable name is joined on later in resolveEmployers(). */
    var employerRef = get(record, index, 'employer');

    /* Five separate columns make up the address. They are kept apart so the
       card can lead with the short name and the filter can group by state,
       and joined into addressText for searching. */
    var address = {
      name: text(get(record, index, 'location')),
      line1: text(get(record, index, 'addressLine1')),
      state: text(get(record, index, 'addressState')),
      country: text(get(record, index, 'addressCountry')),
      pin: text(get(record, index, 'addressPin'))
    };

    return {
      id: record.ID,
      title: text(get(record, index, 'title')) || 'Untitled role',
      employerId: lookupId(employerRef),
      employer: text(employerRef),
      sector: text(get(record, index, 'sector')) || 'General',
      address: address,
      state: address.state,
      addressText: joinParts([address.line1, address.name, address.state,
                              address.country, address.pin]),
      location: address.name || address.state || address.country || '—',
      type: text(get(record, index, 'type')) || 'Full-time',
      salaryMin: minSalary,
      salaryMax: maxSalary,
      experience: text(get(record, index, 'experience')) || 'Not specified',
      qualification: text(get(record, index, 'qualification')) || 'Not specified',
      openings: num(get(record, index, 'openings')) || 1,
      description: text(get(record, index, 'description')),
      skills: list(get(record, index, 'skills')),
      posted: toISODate(get(record, index, 'posted')),
      closes: toISODate(get(record, index, 'closes')),
      urgent: /urgent|high|yes|true/i.test(text(get(record, index, 'priority')))
    };
  }

  /* ------------------------------------------------------------------------
     listJobs — resolves { jobs, warnings, fields }
     ------------------------------------------------------------------------ */
  function listJobs() {
    if (!hasCreator()) {
      return Promise.reject(new Error(
        'This widget reads live data from Zoho Creator, so it only runs ' +
        'inside Creator. Open the page the widget is embedded on rather than ' +
        'loading widget.html directly.'
      ));
    }

    return Promise.all([describeForm(), fetchPage(null, [])])
      .then(function (results) {
        var formFields = results[0];
        var rows = results[1];
        var index = buildFieldIndex(formFields, rows[0]);

        // Log the resolved mapping — the fastest way to spot a wrong binding.
        if (window.console && console.info) {
          console.info('[Rojgar] field mapping', index.map);
          console.info('[Rojgar] record keys', index.recordKeys);
        }

        if (rows.length) {
          var missing = REQUIRED_FIELDS.filter(function (f) { return !index.map[f]; });
          if (missing.length) {
            throw new Error(
              'Could not find the ' + missing.join(' and ') + ' field in "' +
              CREATOR.jobsReport + '". The report returned: ' +
              index.recordKeys.join(', ') +
              ' — set the right names in FIELD_MAP at the top of data.js.'
            );
          }
        }

        var warnings = Object.keys(FIELD_ALIASES).filter(function (f) {
          return !index.map[f] && OPTIONAL_FIELDS.indexOf(f) === -1;
        });

        var jobs = rows.map(function (r) { return mapRecordToJob(r, index); });

        // Employer sits behind the Provider_ID lookup, so it needs a join.
        return resolveEmployers(jobs).then(function () {
          jobs.forEach(function (j) { if (!j.employer) j.employer = '—'; });

          if (jobs.some(function (j) { return j.employer === '—'; })) {
            warnings.push('employer name (via the Provider_ID lookup)');
          }
          return { jobs: jobs, warnings: warnings, fields: index.recordKeys };
        });
      });
  }

  /* getRecords caps at 1000 per call; record_cursor pages past that. */
  function fetchPage(cursor, accumulated) {
    var config = {
      app_name: CREATOR.appName,
      report_name: CREATOR.jobsReport,
      /* The default is quick_view, which returns ONLY the columns shown in
         the report's quick view — the usual cause of fields arriving
         undefined even though they exist on the form. */
      field_config: 'all',
      max_records: 1000
    };

    if (CREATOR.jobsCriteria) config.criteria = CREATOR.jobsCriteria;
    if (cursor) config.record_cursor = cursor;

    return withTimeout(
      ZOHO.CREATOR.DATA.getRecords(config), 20000, 'Loading jobs'
    ).then(function (response) {
      // An empty report answers 3100 ("no records"), which is not an error.
      if (response && response.code === 3100) return accumulated;

      var rows = unwrap(response, 'Loading jobs') || [];
      var all = accumulated.concat(rows);

      var next = response.record_cursor ||
        (response.headers && response.headers.record_cursor);

      if (next && rows.length) return fetchPage(next, all);
      return all;
    });
  }

  /* ------------------------------------------------------------------------
     submitApplication — resolves { reference }
     `payload.resume` is a File object from the upload field.
     ------------------------------------------------------------------------ */
  function submitApplication(payload) {
    if (!hasCreator()) {
      return Promise.reject(new Error('Applying requires the widget to be open inside Creator.'));
    }

    if (!CREATOR.applicationForm || !CREATOR.applicationsReport) {
      return Promise.reject(new Error(
        'The application form is not configured yet — set applicationForm ' +
        'and applicationsReport in CREATOR at the top of data.js.'
      ));
    }

    /* A File upload field CANNOT be populated here: addRecords sends JSON and
       there is no way to put a binary in it. Text fields go in first; the
       resume is attached to the resulting record below. */
    return ZOHO.CREATOR.DATA.addRecords({
      app_name: CREATOR.appName,
      form_name: CREATOR.applicationForm,
      payload: {
        data: {
          Job_ID: payload.jobId,
          Job_Title: payload.jobTitle,
          Applicant_Name: payload.fullName,
          Email: payload.email,
          Phone: payload.phone,
          Current_Location: payload.location,
          Total_Experience: payload.experience,
          Highest_Qualification: payload.qualification,
          Cover_Note: payload.coverNote,
          Applied_On: formatCreatorDate(new Date()),
          Resume_Status: 'Pending'
        }
      }
    }).then(function (response) {
      var recordId = unwrap(response, 'Saving application').ID;

      if (!payload.resume) return { reference: recordId };

      /* report_name, not form_name: uploadFile updates an EXISTING record, so
         it addresses it through a report — which needs edit permission for
         the applicant's role, or this fails after the record already exists.
         File upload fields cap at 50 MB server-side; the UI caps at 5 MB. */
      return ZOHO.CREATOR.FILE.uploadFile({
        app_name: CREATOR.appName,
        report_name: CREATOR.applicationsReport,
        id: recordId,
        field_name: CREATOR.resumeField,
        file: payload.resume
      }).then(function (uploadResponse) {
        unwrap(uploadResponse, 'Uploading resume');
        return { reference: recordId };
      })['catch'](function (error) {
        /* The record exists but carries no resume. Don't fail the whole
           application — flag it so it can be chased, and say so plainly. */
        markResumeFailed(recordId);
        throw new Error('Your details were saved, but the resume did not ' +
          'upload. Reference ' + recordId + '. ' + error.message);
      });
    });
  }

  /* Best-effort flag on the orphaned record; failure here is not surfaced. */
  function markResumeFailed(recordId) {
    if (!ZOHO.CREATOR.DATA.updateRecordById) return;
    ZOHO.CREATOR.DATA.updateRecordById({
      app_name: CREATOR.appName,
      report_name: CREATOR.applicationsReport,
      id: recordId,
      payload: { data: { Resume_Status: 'Upload failed' } }
    })['catch'](function () { /* nothing more we can do from the widget */ });
  }

  /* Date → "08-Sep-2026", the format Creator parses in any app locale. */
  function formatCreatorDate(date) {
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return pad(date.getDate()) + '-' + names[date.getMonth()] + '-' + date.getFullYear();
  }

  return {
    init: init,
    hasCreator: hasCreator,
    listJobs: listJobs,
    submitApplication: submitApplication
  };
})();
