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
  providersReport: 'All_Details',
  providerNameField: 'Organization_Name',

  /* Applications: records are CREATED through the form, but the resume is
     UPLOADED against a report — a File upload field cannot be set through
     addRecords, so it takes a second call. Both names are required. */
  applicationForm: 'Apply_For_Job',
  applicationsReport: 'Apply_For_Job_Report',

  /* Set true only if the applicant name column is a Creator *Name* field
     (the composite one with first/last parts) rather than single-line text.
     A Name field rejects a plain string. */
  applicantNameIsNameField: false,

  /* ---- Published (public) pages -------------------------------------------
     A page shared on creatorapp.zohopublic.in has no signed-in Creator user,
     so DATA / META / FILE calls cannot authorise — only the PUBLISH APIs
     work there, and each needs the permalink key of the specific report or
     form it touches. PUBLISH covers reads, writes AND file uploads, so a
     published page is not limited to read-only.

     To find a key: open the report or form in Creator, Share > Publish, and
     copy the alphanumeric characters that follow the component name in the
     permalink. They are per-component; one key does not cover the app.

         .../page-perma/TestWidget/CPYh63OpkW3bdFbA0YyGx...
                        ^component  ^this part is the key

     'auto' switches to PUBLISH when the widget is embedded in a zohopublic
     page; force it with true/false if the detection is ever wrong. */
  publicPage: 'auto',

  publicLinks: {
    // All_Job_Openings — .../report-perma/All_Job_Openings/<key>
    jobsReport: '',

    // All_Details — .../report-perma/All_Details/<key>
    providersReport: '',

    // Apply_For_Job_Report — .../report-perma/Apply_For_Job_Report/<key>
    applicationsReport: '',

    // Apply_For_Job — .../form-perma/Apply_For_Job/<key>
    applicationForm: ''
  },

  /* Full published permalink of the application form. Not used by the UI
     — the apply modal collects everything itself, resume included, since
     PUBLISH.uploadFile works. RojgarAPI.applicationFormUrl() still builds a
     prefilled link to it if a handoff is ever wanted. */
  publicFormUrls: {
    applicationForm: ''
  }
};

/* --------------------------------------------------------------------------
   Local overrides
   --------------------------------------------------------------------------
   config.js sets window.ROJGAR_CONFIG and is NOT in git: the permalink keys
   grant login-free read access to organisation contacts and to applicants'
   personal details, so they must not sit in a public repository. See
   config.example.js for the template.

   A missing config.js is not an error — the page simply keeps the defaults
   above, which is exactly right for a signed-in Creator page.
   -------------------------------------------------------------------------- */
(function applyLocalConfig() {
  if (typeof window === 'undefined' || !window.ROJGAR_CONFIG) return;

  var overrides = window.ROJGAR_CONFIG;

  Object.keys(overrides).forEach(function (key) {
    var value = overrides[key];

    /* Nested groups (publicLinks, publicFormUrls) merge key-by-key so a
       partial override keeps the rest of the group. */
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      CREATOR[key] && typeof CREATOR[key] === 'object') {
      Object.keys(value).forEach(function (inner) {
        if (value[inner]) CREATOR[key][inner] = value[inner];
      });
      return;
    }

    if (value !== undefined && value !== '') CREATOR[key] = value;
  });
})();

/* --------------------------------------------------------------------------
   Application form fields
   --------------------------------------------------------------------------
   Reads are forgiving — a wrong guess just leaves a card field blank. Writes
   are not: addRecords fails outright on a field link name that does not
   exist. So these are resolved against the form's real metadata before the
   payload is built, and anything unresolved is simply left out rather than
   sent speculatively.

   Put exact link names in APPLICATION_FIELD_MAP to skip the resolution.
   -------------------------------------------------------------------------- */
var APPLICATION_FIELD_MAP = {
  orgName: 'Organization_Name',
  jobTitle: 'Job_Title',
  name: 'Name',
  mobile: 'Contact_Number',
  email: 'Email',
  resume: 'Upload_Resume'
};

var APPLICATION_FIELD_ALIASES = {
  orgName: ['Organization_Name', 'Organisation_Name', 'Employer_Name', 'Company_Name'],
  jobTitle: ['Job_Title', 'Applied_For', 'Position', 'Role'],
  name: ['Name', 'Applicant_Name', 'Full_Name', 'Candidate_Name', 'Applicant'],
  mobile: ['Contact_Number', 'Mobile_Number', 'Mobile_No', 'Mobile',
    'Phone_Number', 'Phone', 'Contact_No'],
  email: ['Email', 'Email_Address', 'Email_ID', 'Applicant_Email'],
  resume: ['Upload_Resume', 'Resume', 'Resume_Upload', 'Resume_File', 'CV',
    'Attachment'],
  jobId: ['Job_ID', 'Job_Opening_ID', 'Job_Opening', 'Applied_Job'],
  appliedOn: ['Applied_On', 'Application_Date', 'Applied_Date', 'Date_Applied']
};

/* Without somewhere to put these there is no application worth saving. */
var APPLICATION_REQUIRED = ['name', 'mobile', 'email'];

/* These two are LOOKUPS on Apply_For_Job, not text:
     Job_Title         -> a record in Job_Openings
     Organization_Name -> a record in the provider form
   A lookup is written by sending the referenced record's ID. Sending the
   display text instead either fails outright or stores a dangling
   reference, so the IDs are carried through the submit payload and the
   human-readable strings are used only in the UI. */
var APPLICATION_LOOKUP_FIELDS = {
  jobTitle: 'jobId',        // payload key holding the Job_Openings record ID
  orgName: 'employerId'     // payload key holding the provider record ID
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

/* The provider's own business key — "ORG-008" in All_Details. A lookup may
   display this rather than the Creator record ID, so the join has to be able
   to match on it too. */
var PROVIDER_KEY_ALIASES = [
  'Provider_ID', 'Provider_Code', 'Organization_ID', 'Organisation_ID',
  'Org_ID', 'Org_Code', 'Code'
];

/* How an organisation identifies itself on the applicants page. These are
   All_Details columns — the provider's own contact details, not the
   applicant's Contact_Number on Apply_For_Job. */
var PROVIDER_EMAIL_ALIASES = ['Email', 'Email_Address', 'Email_ID', 'Contact_Email'];
var PROVIDER_MOBILE_ALIASES = [
  'Mobile_Number', 'Mobile_No', 'Mobile', 'Phone_Number', 'Phone',
  'Contact_Number', 'Contact_No'
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

  /* Set once a DATA call has failed somewhere a Publish key exists — see
     readRecords. Sticky, so the fallback is paid for at most once. */
  var publicModeDetected = false;

  /* Detecting a published page from inside a cross-origin iframe is
     awkward. referrer is the obvious signal but is frequently stripped by
     referrer policy — which is why the first attempt still went to the DATA
     endpoint — so ancestorOrigins is checked first: it names the parent
     frame's origin even cross-origin, on Chromium and Safari. Firefox has
     neither reliably, which is what the runtime fallback is for. */
  function isPublicPage() {
    if (CREATOR.publicPage === true) return true;
    if (CREATOR.publicPage === false) return false;
    if (publicModeDetected) return true;

    try {
      var origins = window.location.ancestorOrigins;
      if (origins) {
        for (var i = 0; i < origins.length; i++) {
          if (/zohopublic\./i.test(origins[i])) return true;
        }
      }
    } catch (e) { /* not supported here */ }

    try {
      if (/zohopublic\./i.test(document.referrer || '')) return true;
    } catch (e) { /* blocked */ }

    return false;
  }

  function namespace() {
    return isPublicPage() ? ZOHO.CREATOR.PUBLISH : ZOHO.CREATOR.DATA;
  }

  function hasCreator() {
    if (typeof ZOHO === 'undefined' || !ZOHO.CREATOR || !inCreatorFrame()) return false;
    var ns = isPublicPage() ? ZOHO.CREATOR.PUBLISH : ZOHO.CREATOR.DATA;
    return !!ns && typeof ns.getRecords === 'function';
  }

  function assign(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  /* Missing permalink keys are the single most likely reason a published
     page shows nothing, so the message says exactly what to fetch and where
     to put it rather than surfacing a permission error. */
  function missingLinkError(target, componentName) {
    var kind = target === 'applicationForm' ? 'form-perma' : 'report-perma';
    return new Error(
      'This page is published publicly, so it has to use Creator\'s Publish ' +
      'API — and that needs the permalink key for "' + componentName + '". ' +
      'Publish it in Creator and copy the key from the end of its permalink ' +
      '(.../' + kind + '/' + componentName + '/THIS_PART), then set ' +
      'publicLinks.' + target + ' in data.js.'
    );
  }

  /* Worth retrying only when there is a key to use and a namespace to call. */
  function canRetryViaPublish(target) {
    return !!CREATOR.publicLinks[target] &&
      !!ZOHO.CREATOR.PUBLISH &&
      typeof ZOHO.CREATOR.PUBLISH.getRecords === 'function';
  }

  function publishConfig(target, componentName, config) {
    var link = CREATOR.publicLinks[target];
    if (!link) throw missingLinkError(target, componentName);
    return assign({ private_link: link }, config);
  }

  /* Every read and write goes through these two, so the DATA/PUBLISH choice
     lives in one place rather than at six call sites.

     When detection says "not public" but a DATA call fails anyway, it is
     retried once through PUBLISH provided a key is configured. That covers
     the case that actually bit us: on a published page with the referrer
     stripped, nothing identifies the context until Creator refuses the
     request. A success flips publicModeDetected so it is paid for once. */
  function readRecords(target, componentName, config) {
    if (isPublicPage()) {
      return Promise.resolve().then(function () {
        return ZOHO.CREATOR.PUBLISH.getRecords(
          publishConfig(target, componentName, config));
      });
    }

    return ZOHO.CREATOR.DATA.getRecords(config)['catch'](function (error) {
      if (!canRetryViaPublish(target)) throw error;

      if (window.console) {
        console.info('[Rojgar] DATA call failed; retrying "' + componentName +
          '" through the Publish API. This page looks published.');
      }

      return ZOHO.CREATOR.PUBLISH.getRecords(
        publishConfig(target, componentName, config)
      ).then(function (response) {
        publicModeDetected = true;
        return response;
      })['catch'](function () {
        /* Both failed. Report the DATA error, not the Publish one: on a page
           that is genuinely signed in, "you lack permission" is the real
           problem and a publish-key complaint would send you chasing the
           wrong thing. */
        throw error;
      });
    });
  }

  /* PUBLISH.uploadFile is undocumented — Zoho's publish-api/upload-file page
     404s and they list uploads under "File APIs" — but it is present in the
     shipped SDK and takes the same private_link as the other publish calls.
     So a published page CAN attach a resume. */
  function uploadRecordFile(target, componentName, config) {
    if (isPublicPage()) {
      return Promise.resolve().then(function () {
        return ZOHO.CREATOR.PUBLISH.uploadFile(
          publishConfig(target, componentName, config));
      });
    }

    return ZOHO.CREATOR.FILE.uploadFile(config)['catch'](function (error) {
      if (!canRetryViaPublish(target) ||
          typeof ZOHO.CREATOR.PUBLISH.uploadFile !== 'function') {
        throw error;
      }

      return ZOHO.CREATOR.PUBLISH.uploadFile(
        publishConfig(target, componentName, config)
      ).then(function (response) {
        publicModeDetected = true;
        return response;
      })['catch'](function () { throw error; });
    });
  }

  function createRecord(target, componentName, config) {
    if (isPublicPage()) {
      return Promise.resolve().then(function () {
        return ZOHO.CREATOR.PUBLISH.addRecords(
          publishConfig(target, componentName, config));
      });
    }

    return ZOHO.CREATOR.DATA.addRecords(config)['catch'](function (error) {
      if (!canRetryViaPublish(target)) throw error;

      return ZOHO.CREATOR.PUBLISH.addRecords(
        publishConfig(target, componentName, config)
      ).then(function (response) {
        publicModeDetected = true;
        return response;
      })['catch'](function () { throw error; });
    });
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
  /* The SDK rejects with its raw response object — { code, message, ... } —
     not an Error, so `error.message` is often undefined and every caller
     fell back to a useless "Could not reach Zoho Creator". Everything
     leaving this module is turned into a real Error carrying whatever the
     response actually said, and the raw object is logged for diagnosis. */
  function normaliseError(error, context) {
    if (window.console) console.error('[Rojgar] raw error', context || '', error);

    if (error instanceof Error) return error;

    var info = unpackCreatorResponse(error);
    var message = info.message;

    /* Creator's own wording is written for developers. The ones an employer
       or applicant can actually act on get replaced — and those read
       cleanly, so no code is appended. */
    if (info.code !== null && FRIENDLY_CODES[info.code]) {
      return new Error(context
        ? context + ': ' + FRIENDLY_CODES[info.code]
        : FRIENDLY_CODES[info.code]);
    }

    if (!message) {
      message = info.status
        ? 'Zoho Creator returned HTTP ' + info.status + '.'
        : safeJson(error);
    }

    // An unrecognised code stays visible: it is what makes the cause findable.
    if (info.code !== null) message += ' (code ' + info.code + ')';

    return new Error(context ? context + ': ' + message : message);
  }

  function safeJson(value) {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }

  /* The SDK rejects with an XHR-shaped object whose real payload is a JSON
     STRING inside responseText:

       { status: 400, statusText: "",
         responseText: "{\"code\":9280,\"message\":\"No records found…\"}" }

     Reading .code or .message off the top level finds nothing, and
     String(value) gives "[object Object]" — so the payload is unpacked here
     before anything tries to interpret it. */
  function unpackCreatorResponse(value) {
    var out = { code: null, message: '', status: null };
    if (!value) return out;

    if (typeof value === 'string') { out.message = value; return out; }
    if (typeof value !== 'object') { out.message = String(value); return out; }

    out.status = value.status || null;
    if (value.code !== undefined && value.code !== null) out.code = value.code;
    if (value.message) out.message = String(value.message);
    else if (value.description) out.message = String(value.description);

    var raw = value.responseText || value.responseJSON || value.response;

    if (typeof raw === 'string') {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (out.code === null && parsed.code !== undefined) out.code = parsed.code;
          if (!out.message) out.message = String(parsed.message || parsed.description || '');
        }
      } catch (e) {
        if (!out.message) out.message = raw;   // not JSON after all
      }
    } else if (raw && typeof raw === 'object') {
      if (out.code === null && raw.code !== undefined) out.code = raw.code;
      if (!out.message) out.message = String(raw.message || raw.description || '');
    }

    return out;
  }

  /* Creator's "nothing matched" codes. 9280 is what getRecords returns for a
     criteria that matches no rows; 3100 is the older empty-report code. */
  var NO_RECORD_CODES = [3100, 9280];

  /* Codes worth restating in plain language. Anything not listed keeps
     Creator's own wording, which still beats a generic failure message. */
  var FRIENDLY_CODES = {
    2945: 'This widget does not have permission to read that report. Ask your ' +
      'Creator administrator to grant access.',
    3320: 'You do not have permission to view this report.',
    4890: 'Creator could not authenticate this session. Reload the page and try again.',
    6001: 'That application or report does not exist in Creator.'
  };

  /* An empty result is not a failure. */
  function isNoRecords(value) {
    if (!value) return false;
    var info = unpackCreatorResponse(value);
    if (info.code !== null && NO_RECORD_CODES.indexOf(Number(info.code)) !== -1) {
      return true;
    }
    return /no record/i.test(info.message);
  }

  /* Wraps a promise so anything it rejects with arrives as a real Error. */
  function reported(promise, context) {
    return promise['catch'](function (error) {
      throw normaliseError(error, context);
    });
  }

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
    /* META is not a Publish API: on a published page it cannot authorise,
       so field names come from the pinned maps and the record keys instead. */
    if (isPublicPage()) return Promise.resolve([]);
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

          /* One direction only: the real column must EXTEND the alias
             ("Monthly_Salary_Min" -> "Monthly_Salary_Min_years").

             Matching the other way round — alias contains column — looks
             symmetric but is not: it let the 2-character "ID" column bind to
             "closes" via the alias "Valid_Till", because "validtill"
             contains "id". Short column names are substrings of half the
             English language, so that direction is dropped entirely. */
          if (k.indexOf(a) === -1) return;

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

  /* Business keys are compared case- and space-insensitively so "org-008"
     and "ORG-008 " both find the provider. */
  function providerKey(value) {
    return String(text(value) || '').trim().toUpperCase();
  }

  /* First alias that exists as a column on a returned record, matched
     exactly then normalised. */
  function resolveColumn(record, aliases) {
    if (!record) return '';
    var byNorm = {};
    Object.keys(record).forEach(function (k) { byNorm[normalise(k)] = k; });

    for (var i = 0; i < aliases.length; i++) {
      if (record.hasOwnProperty(aliases[i])) return aliases[i];
      var hit = byNorm[normalise(aliases[i])];
      if (hit) return hit;
    }
    return '';
  }

  /* Finds the report holding provider records, preferring an explicit
     setting and otherwise matching the app's report list by name. */
  function findProvidersReport() {
    if (CREATOR.providersReport) return Promise.resolve(CREATOR.providersReport);

    /* META is not a Publish API: on a published page it cannot authorise,
       so field names come from the pinned maps and the record keys instead. */
    if (isPublicPage()) return Promise.resolve([]);
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
    return withTimeout(readRecords('providersReport', reportName, {
      app_name: CREATOR.appName,
      report_name: reportName,
      field_config: 'all',
      max_records: 1000
    }), 20000, 'Loading employers').then(function (response) {
      if (response && response.code === 3100) return {};
      var rows = unwrap(response, 'Loading employers') || [];
      if (!rows.length) return {};

      var nameField = CREATOR.providerNameField &&
        rows[0].hasOwnProperty(CREATOR.providerNameField)
        ? CREATOR.providerNameField
        : resolveColumn(rows[0], PROVIDER_NAME_ALIASES);

      if (!nameField) return {};

      // The business-key column, so a lookup showing "ORG-008" still joins.
      var keyField = resolveColumn(rows[0], PROVIDER_KEY_ALIASES);

      if (window.console && console.info) {
        console.info('[Rojgar] employer names from ' + reportName + '.' + nameField +
          (keyField ? ' (also keyed by ' + keyField + ')' : ''));
      }

      /* Indexed under every identifier a job could reference: the Creator
         record ID, and the provider's own code. */
      var names = {};
      rows.forEach(function (r) {
        var orgName = text(r[nameField]);
        if (!orgName) return;
        if (r.ID) names[String(r.ID)] = orgName;
        if (keyField && r[keyField]) names[providerKey(r[keyField])] = orgName;
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
  /* Fills in job.employer from the provider records.

     The join always runs when a job carries any provider reference, because
     there is no reliable way to tell an org name from a business key by
     looking at it — "ORG-008" is neither a Creator record ID nor a name, and
     an earlier version that only joined when the value looked like a numeric
     ID left codes showing on the cards.

     Jobs are matched on either identifier: the Creator record ID behind the
     lookup, or the provider's own code as displayed. A job whose reference
     matches nothing keeps whatever the lookup gave, unless that is a bare
     record ID, which is meaningless to a reader. */
  function resolveEmployers(jobs) {
    var hasReference = jobs.some(function (j) { return j.employerId || j.employer; });
    if (!hasReference) return Promise.resolve(false);

    return findProvidersReport().then(function (reportName) {
      if (!reportName) return false;

      return loadProviderNames(reportName).then(function (names) {
        var matched = 0;

        jobs.forEach(function (job) {
          var name = names[job.employerId] || names[providerKey(job.employer)];
          if (name) {
            job.employer = name;
            matched++;
          } else if (looksLikeRecordId(job.employer)) {
            job.employer = '—';
          }
        });

        if (window.console && console.info) {
          console.info('[Rojgar] employer names resolved for ' + matched +
            '/' + jobs.length + ' jobs');
        }
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
      readRecords('jobsReport', CREATOR.jobsReport, config), 20000, 'Loading jobs'
    )['catch'](function (error) {
      // "No record found matching this criteria" arrives as a rejection.
      if (isNoRecords(error)) return { code: 3100 };
      throw error;
    }).then(function (response) {
      // An empty report answers 3100 ("no records"), which is not an error.
      if (isNoRecords(response)) return accumulated;

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

    return resolveApplicationFields().then(function (fields) {
      var missing = APPLICATION_REQUIRED.filter(function (f) { return !fields[f]; });
      if (missing.length) {
        throw new Error(
          'The "' + CREATOR.applicationForm + '" form has no field for ' +
          missing.join(', ') + '. Its fields are: ' +
          (fields.__all || []).join(', ') +
          ' — set the right names in APPLICATION_FIELD_MAP in data.js.'
        );
      }

      function buildData(nameAsComposite) {
        var data = {};
        data[fields.name] = nameAsComposite
          ? splitName(payload.fullName)
          : payload.fullName;
        data[fields.mobile] = payload.phone;
        data[fields.email] = payload.email;

        /* Lookups take the referenced record's ID. Omitted when we have no
           ID — a lookup given display text is worse than an absent one. */
        Object.keys(APPLICATION_LOOKUP_FIELDS).forEach(function (logical) {
          var linkName = fields[logical];
          if (!linkName) return;

          var recordId = payload[APPLICATION_LOOKUP_FIELDS[logical]];
          if (recordId) {
            data[linkName] = String(recordId);
          } else if (window.console) {
            console.warn('[Rojgar] no record ID for the ' + linkName +
              ' lookup, so it is being left empty.');
          }
        });

        // Only sent when the form actually has somewhere to put them.
        if (fields.jobId) data[fields.jobId] = payload.jobId;
        if (fields.appliedOn) data[fields.appliedOn] = formatCreatorDate(new Date());
        return data;
      }

      /* A File upload field CANNOT be populated here: addRecords sends JSON
         and there is no way to put a binary in it. Text fields go in first;
         the resume is attached to the resulting record below. */
      function create(nameAsComposite) {
        return createRecord('applicationForm', CREATOR.applicationForm, {
          app_name: CREATOR.appName,
          form_name: CREATOR.applicationForm,
          payload: { data: buildData(nameAsComposite) }
        }).then(function (response) {
          return unwrap(response, 'Saving application').ID;
        });
      }

      /* A Creator *Name* field rejects a plain string, and the field here is
         literally called "Name" — so if the first attempt fails, retry once
         with { first_name, last_name } before giving up. A non-3000 response
         means nothing was created, so the retry cannot duplicate a record.
         Set applicantNameIsNameField to skip straight to the composite. */
      var first = CREATOR.applicantNameIsNameField;

      return create(first)['catch'](function (error) {
        return create(!first).then(function (recordId) {
          if (window.console) {
            console.info('[Rojgar] "' + fields.name + '" is a ' +
              (first ? 'plain text' : 'Name') + ' field — set ' +
              'applicantNameIsNameField to ' + String(!first) + ' in data.js.');
          }
          return recordId;
        })['catch'](function () { throw error; });   // report the original
      }).then(function (recordId) {

        if (!payload.resume) return { reference: recordId };

        if (!fields.resume) {
          throw new Error('Your details were saved (reference ' + recordId +
            '), but "' + CREATOR.applicationForm + '" has no file upload ' +
            'field for the resume.');
        }

        /* report_name, not form_name: uploadFile updates an EXISTING record,
           so it addresses it through a report — which needs edit permission
           for the applicant's role, or this fails after the record already
           exists. File upload fields cap at 50 MB; the UI caps at 5 MB.

           Routed, so a published page goes through PUBLISH.uploadFile with
           the applicationsReport permalink key. */
        return uploadRecordFile('applicationsReport', CREATOR.applicationsReport, {
          app_name: CREATOR.appName,
          report_name: CREATOR.applicationsReport,
          id: recordId,
          field_name: fields.resume,
          file: payload.resume
        }).then(function (uploadResponse) {
          unwrap(uploadResponse, 'Uploading resume');
          return { reference: recordId };
        })['catch'](function (error) {
          /* The record exists but carries no resume. Don't pretend the whole
             application failed — say exactly what happened, with the
             reference, so it can be chased. */
          throw new Error('Your details were saved, but the resume did not ' +
            'upload. Reference ' + recordId + '. ' + error.message);
        });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Employer sign-in and their applicants
     ------------------------------------------------------------------------
     An organisation identifies itself with the email and mobile on its
     All_Details record; both must match. Its record ID then filters
     Apply_For_Job_Report, because Organization_Name there is a lookup and a
     lookup is queried by the referenced record's ID.

     Only the email goes into the Creator criteria. The mobile is matched
     here, on the last ten digits, because All_Details stores numbers like
     "+919432109876" and nobody types the country code — criteria string
     equality would silently return nothing and look like "no applicants".
     ------------------------------------------------------------------------ */
  function findProvider(email, mobile) {
    var wantedEmail = String(email || '').trim().toLowerCase();
    var wantedPhone = lastTenDigits(mobile);

    if (!wantedEmail || !wantedPhone) {
      return Promise.reject(new Error('Enter both an email address and a mobile number.'));
    }

    return findProvidersReport().then(function (reportName) {
      if (!reportName) {
        throw new Error('Could not find the organisation report (' +
          CREATOR.providersReport + ').');
      }

      /* Matched entirely client-side, with no criteria at all. A criteria
         would have to name the email column, and guessing it wrong ("Email"
         vs "Email_Address") returns zero rows that look exactly like "no
         such organisation" — plus Creator's string comparison is
         case-sensitive. Organisation lists are small, so scanning is both
         cheaper to reason about and strictly more reliable. */
      return fetchAllProviders(reportName).then(function (rows) {
        if (!rows.length) {
          throw new Error('The organisation report "' + reportName +
            '" returned no records. Check the report name in data.js and ' +
            'that your Creator role can read it.');
        }

        var emailField = resolveColumn(rows[0], PROVIDER_EMAIL_ALIASES);
        var mobileField = resolveColumn(rows[0], PROVIDER_MOBILE_ALIASES);
        var nameField = (CREATOR.providerNameField &&
          rows[0].hasOwnProperty(CREATOR.providerNameField))
          ? CREATOR.providerNameField
          : resolveColumn(rows[0], PROVIDER_NAME_ALIASES);

        if (window.console && console.info) {
          console.info('[Rojgar] organisation sign-in using ' + reportName +
            ' — email: ' + (emailField || 'NOT FOUND') +
            ', mobile: ' + (mobileField || 'NOT FOUND') +
            ', name: ' + (nameField || 'NOT FOUND') +
            ' (' + rows.length + ' records)');
        }

        if (!emailField || !mobileField) {
          throw new Error('Could not find an ' +
            (!emailField ? 'email' : 'mobile number') + ' column in "' +
            reportName + '". Its columns are: ' + Object.keys(rows[0]).join(', '));
        }

        /* Separated so "wrong password" and "no such account" can be told
           apart — one is a typo in the mobile, the other a wrong email. */
        var emailMatches = rows.filter(function (r) {
          return text(r[emailField]).trim().toLowerCase() === wantedEmail;
        });

        if (!emailMatches.length) {
          throw new Error('No organisation is registered with that email address.');
        }

        var match = null;
        emailMatches.forEach(function (r) {
          var rowPhone = lastTenDigits(r[mobileField]);
          if (rowPhone && rowPhone === wantedPhone) match = r;
        });

        if (!match) {
          throw new Error('That mobile number does not match the one registered ' +
            'against this email address.');
        }

        return {
          id: String(match.ID),
          name: text(match[nameField]) || 'Your organisation',
          email: text(match[emailField]),
          mobile: text(match[mobileField])
        };
      });
    });
  }

  /* Everyone who applied to this organisation's jobs. */
  function listApplicantsForProvider(email, mobile) {
    if (!hasCreator()) {
      return Promise.reject(new Error(
        'This page reads live data from Zoho Creator, so it only runs inside Creator.'
      ));
    }

    /* Sign-in failures are tagged so the page knows to send the employer
       back to the form. Anything that goes wrong AFTER a successful
       sign-in must not do that — they are signed in, and bouncing them to
       the login screen hides that fact. */
    return findProvider(email, mobile)['catch'](function (error) {
      var signInError = normaliseError(error, 'Signing in');
      signInError.stage = 'signin';
      throw signInError;
    }).then(function (provider) {
      return resolveApplicationFields().then(function (fields) {
        if (!fields.orgName) {
          throw new Error('No organisation field found on ' +
            CREATOR.applicationForm + '.');
        }

        /* A lookup is filtered by the referenced record's ID, not its text. */
        return withTimeout(readRecords('applicationsReport',
          CREATOR.applicationsReport, {
          app_name: CREATOR.appName,
          report_name: CREATOR.applicationsReport,
          field_config: 'all',
          criteria: fields.orgName + ' == ' + provider.id,
          max_records: 1000
        }), 20000, 'Loading applicants').then(function (response) {
          if (isNoRecords(response)) return [];
          return unwrap(response, 'Loading applicants') || [];
        })['catch'](function (error) {
          // An empty report is an empty list, never an error.
          if (isNoRecords(error)) return [];
          throw error;
        }).then(function (rows) {
          return decorateApplications(rows, fields);
        }).then(function (applications) {
          return { provider: provider, applications: applications, loadError: null };
        })['catch'](function (error) {
          /* Still signed in — report the problem beside the organisation
             rather than throwing them back to the login form. */
          return {
            provider: provider,
            applications: [],
            loadError: normaliseError(error, 'Loading applicants').message
          };
        });
      });
    });
  }

  /* Every organisation record, so sign-in can match without a criteria. */
  function fetchAllProviders(reportName) {
    return withTimeout(readRecords('providersReport', reportName, {
      app_name: CREATOR.appName,
      report_name: reportName,
      field_config: 'all',
      max_records: 1000
    }), 20000, 'Signing in').then(function (response) {
      if (response && response.code === 3100) return [];
      return unwrap(response, 'Signing in') || [];
    });
  }

  /* Job_Title and Organization_Name are lookups, so the row carries a
     reference rather than readable text — and the display value may well be
     an ID. The jobs are fetched once and matched by record ID so each
     application can be shown as a full card. */
  function decorateApplications(rows, fields) {
    var applications = rows.map(function (r) {
      return {
        id: r.ID,
        jobId: lookupId(r[fields.jobTitle]) || '',
        jobTitle: text(r[fields.jobTitle]),
        orgName: text(r[fields.orgName]),
        applicantName: text(r[fields.name]),
        email: text(r[fields.email]),
        mobile: text(r[fields.mobile]),
        resume: text(r[fields.resume]),
        appliedOn: toISODate(r[fields.appliedOn] || r.Added_Time)
      };
    });

    if (!applications.length) return Promise.resolve([]);

    return listJobs().then(function (result) {
      var byId = {};
      result.jobs.forEach(function (j) { byId[String(j.id)] = j; });

      applications.forEach(function (a) {
        var job = byId[a.jobId];
        if (!job) return;
        a.job = job;
        // The joined values beat the lookup's display text, which may be an ID.
        a.jobTitle = job.title;
        if (job.employer && job.employer !== '—') a.orgName = job.employer;
      });

      return applications;
    })['catch'](function () {
      // The applications themselves are worth showing even if jobs fail.
      return applications;
    });
  }

  /* Indian mobile numbers reach us as "+919876543210", "09876543210" or
     "98765 43210"; the last ten digits are the stable part. */
  function lastTenDigits(value) {
    var digits = String(text(value) || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  }

  /* Resolved once per session — the form's fields do not change mid-use. */
  var applicationFieldsCache = null;

  function resolveApplicationFields() {
    if (applicationFieldsCache) return Promise.resolve(applicationFieldsCache);

    /* Metadata is an aid, not a gate. A name pinned in APPLICATION_FIELD_MAP
       is used whatever META says — it was given to us deliberately, and a
       failed or empty getFields must not stop an application being saved.
       META only fills in what is not pinned, and supplies the field list for
       the error message when something cannot be placed. */
    return describeApplicationForm().then(function (formFields) {
      var byLink = {};
      var byDisplay = {};
      var all = [];

      formFields.forEach(function (f) {
        if (!f || !f.link_name) return;
        all.push(f.link_name);
        byLink[normalise(f.link_name)] = f.link_name;
        if (f.display_name) byDisplay[normalise(f.display_name)] = f.link_name;
      });

      var resolved = { __all: all };

      Object.keys(APPLICATION_FIELD_ALIASES).forEach(function (logical) {
        if (APPLICATION_FIELD_MAP[logical]) {
          resolved[logical] = APPLICATION_FIELD_MAP[logical];
          return;
        }
        var aliases = APPLICATION_FIELD_ALIASES[logical];
        for (var i = 0; i < aliases.length; i++) {
          var hit = byLink[normalise(aliases[i])] || byDisplay[normalise(aliases[i])];
          if (hit) { resolved[logical] = hit; return; }
        }
      });

      // Flag a pinned name the form does not actually have — the write would
      // fail on it, and this says so before Creator's opaque error does.
      if (all.length) {
        Object.keys(APPLICATION_FIELD_MAP).forEach(function (logical) {
          var pinned = APPLICATION_FIELD_MAP[logical];
          if (pinned && all.indexOf(pinned) === -1 && window.console) {
            console.warn('[Rojgar] "' + pinned + '" is pinned for ' + logical +
              ' but is not a field on ' + CREATOR.applicationForm +
              '. Form has: ' + all.join(', '));
          }
        });
      }

      if (window.console && console.info) {
        console.info('[Rojgar] application field mapping', resolved);
      }

      applicationFieldsCache = resolved;
      return resolved;
    });
  }

  /* Resolves to [] rather than rejecting — see resolveApplicationFields. */
  function describeApplicationForm() {
    /* META is not a Publish API: on a published page it cannot authorise,
       so field names come from the pinned maps and the record keys instead. */
    if (isPublicPage()) return Promise.resolve([]);
    if (!ZOHO.CREATOR.META || typeof ZOHO.CREATOR.META.getFields !== 'function') {
      return Promise.resolve([]);
    }
    return withTimeout(ZOHO.CREATOR.META.getFields({
      app_name: CREATOR.appName,
      form_name: CREATOR.applicationForm
    }), 15000, 'Reading application form').then(function (response) {
      return unwrap(response, 'Reading application form', 'fields') || [];
    })['catch'](function (error) {
      if (window.console) console.warn('[Rojgar] could not read application form', error);
      return [];
    });
  }

  /* Creator Name fields want the parts separately. Everything after the
     first token is the surname, so "Asha Rani Devi" keeps "Rani Devi". */
  function splitName(fullName) {
    var parts = String(fullName || '').trim().split(/\s+/);
    return {
      first_name: parts.shift() || '',
      last_name: parts.join(' ')
    };
  }

  /* ------------------------------------------------------------------------
     Published application form
     ------------------------------------------------------------------------
     Creator prefills a published form from query parameters keyed by field
     LINK name, read once on load. Job_Title and Organization_Name are
     lookups, so they take the referenced record's ID exactly as the API
     does — passing the display text would leave them empty.
     ------------------------------------------------------------------------ */
  function applicationFormUrl(params) {
    var base = CREATOR.publicFormUrls && CREATOR.publicFormUrls.applicationForm;
    if (!base) return '';

    params = params || {};

    var fields = APPLICATION_FIELD_MAP;
    var query = [];

    function add(fieldName, value) {
      if (!fieldName || !value) return;
      query.push(encodeURIComponent(fieldName) + '=' + encodeURIComponent(value));
    }

    add(fields.jobTitle || 'Job_Title', params.jobId);
    add(fields.orgName || 'Organization_Name', params.employerId);

    if (!query.length) return base;
    return base + (base.indexOf('?') === -1 ? '?' : '&') + query.join('&');
  }

  /* Date → "08-Sep-2026", the format Creator parses in any app locale. */
  function formatCreatorDate(date) {
    var names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return pad(date.getDate()) + '-' + names[date.getMonth()] + '-' + date.getFullYear();
  }

  /* Public surface. Every entry point is wrapped so a caller can rely on
     rejections being real Errors with a readable message. */
  return {
    init: init,
    hasCreator: hasCreator,

    /* The UI needs this: a published page cannot upload files, so the resume
       field is hidden there rather than accepted and then dropped. */
    isPublicPage: isPublicPage,

    /* Published permalink of the application form, prefilled for this job.
       Empty when no form URL is configured, which is the signal to fall back
       to the widget's own in-page form. */
    applicationFormUrl: applicationFormUrl,

    /* Promise.resolve().then() so a SYNCHRONOUS throw inside the SDK becomes
       a rejection rather than escaping the promise chain entirely. */
    listJobs: function () {
      return reported(Promise.resolve().then(listJobs), 'Loading jobs');
    },

    submitApplication: function (payload) {
      return reported(Promise.resolve().then(function () {
        return submitApplication(payload);
      }), 'Submitting application');
    },

    listApplicantsForProvider: function (email, mobile) {
      return reported(Promise.resolve().then(function () {
        return listApplicantsForProvider(email, mobile);
      }), 'Signing in');
    }
  };
})();
