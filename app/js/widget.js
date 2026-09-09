/* ==========================================================================
   Rojgar — UI
   --------------------------------------------------------------------------
   Renders the job grid, drives search/filter/sort, and runs the apply modal
   (validation, resume upload, submit). All data access goes through
   RojgarAPI in data.js — nothing here knows whether it is live or sample.
   ========================================================================== */

(function () {
  'use strict';

  /* ---- Constants -------------------------------------------------------- */

  var MAX_SKILL_CHIPS = 3;
  var MAX_RESUME_BYTES = 5 * 1024 * 1024;               // 5 MB
  var RESUME_EXTENSIONS = ['pdf', 'doc', 'docx'];
  var NEW_WITHIN_DAYS = 3;                              // "New" badge window
  var CLOSING_WITHIN_DAYS = 7;                          // "Closing soon" badge

  var TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Apprenticeship'];

  /* Sector → accent token. Anything unlisted falls back to slot 1. */
  var SECTOR_ACCENT = {
    'IT-ITeS': 1,
    'Green Jobs': 2,
    'Logistics': 3,
    'Electronics': 4,
    'Beauty & Wellness': 5,
    'Agriculture': 6,
    'Apparel': 7,
    'Automotive': 8,
    'Retail': 9,
    'Power': 10
  };

  /* ---- State ------------------------------------------------------------ */

  var state = {
    jobs: [],
    query: '',
    type: 'all',
    location: 'all',
    pincode: 'all',
    sort: 'recent',
    applied: {},        // jobId → reference, for this session only
    saved: {},          // jobId → true, bookmark toggle, session only
    activeJob: null,
    resumeFile: null,
    lastFocused: null
  };

  /* ---- Element handles -------------------------------------------------- */

  var el = {};

  function cacheElements() {
    [
      'mockBanner', 'jobs', 'search', 'searchClear', 'chips', 'locationFilter',
      'pincodeFilter', 'sortBy', 'resultCount', 'statOpen', 'statEmployers', 'statNew',
      'bannerText',
      'modal', 'modalPanel', 'modalJobTitle', 'modalOrgName', 'modalJobMeta', 'modalClose',
      'modalBody', 'modalFoot', 'applyForm', 'submitBtn', 'cancelBtn',
      'dropzone', 'resumeInput', 'fileCard', 'fileIcon', 'fileName', 'fileSize',
      'fileRemove', 'resumeField', 'toasts'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  /* ==========================================================================
     Helpers
     ========================================================================== */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Whole days between an ISO date and today; negative means in the past. */
  function daysFromToday(iso) {
    if (!iso) return null;
    var then = new Date(iso + 'T00:00:00');
    if (isNaN(then)) return null;
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((then - now) / 86400000);
  }

  /* Whole days since an ISO date, or null when it is missing/unparseable. */
  function daysSince(iso) {
    var d = daysFromToday(iso);
    return d === null ? null : -d;
  }

  function postedLabel(iso) {
    var ago = daysSince(iso);
    if (ago === null) return 'Recently posted';
    if (ago <= 0) return 'Posted today';
    if (ago === 1) return 'Posted yesterday';
    if (ago < 7) return 'Posted ' + ago + 'd ago';
    if (ago < 30) return 'Posted ' + Math.floor(ago / 7) + 'w ago';
    return 'Posted ' + Math.floor(ago / 30) + 'mo ago';
  }

  /* 18000 → "₹18,000" using the Indian digit grouping. */
  function rupees(amount) {
    return '₹' + Number(amount || 0).toLocaleString('en-IN');
  }

  /* The "per month" unit is rendered beside this, so it is not repeated here. */
  function salaryLabel(job) {
    if (!job.salaryMin && !job.salaryMax) return 'Not disclosed';
    if (!job.salaryMax || job.salaryMin === job.salaryMax) return rupees(job.salaryMin);
    return rupees(job.salaryMin) + ' – ' + rupees(job.salaryMax);
  }

  function fileSizeLabel(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function initials(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function pincodeOf(job) {
    return String((job.address && job.address.pin) || '').trim();
  }

  /* Groups the location filter. Prefers the real State column; falls back to
     the tail of a comma-separated location for records without one. */
  function regionOf(job) {
    if (job.state) return String(job.state).trim();
    var parts = String(job.location || '').split(',');
    return parts.length > 1
      ? parts[parts.length - 1].trim()
      : String(job.location || '').trim();
  }

  function icon(paths, size) {
    var s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  var ICONS = {
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    bag: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M9 8h6M9 12h6M10 8c3 0 3 4 0 4l4 4"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 14 3-3 3 3 5-6"/>',
    cap: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>'
  };

  /* ==========================================================================
     Rendering — job cards
     ========================================================================== */

  function badgesFor(job) {
    var out = [];
    var postedAgo = daysSince(job.posted);
    var closesIn = daysFromToday(job.closes);

    if (job.urgent) out.push('<span class="badge badge--urgent">Urgent</span>');
    else if (postedAgo !== null && postedAgo <= NEW_WITHIN_DAYS) {
      out.push('<span class="badge badge--new">New</span>');
    }

    if (closesIn !== null && closesIn >= 0 && closesIn <= CLOSING_WITHIN_DAYS) {
      out.push('<span class="badge badge--closing">' +
        (closesIn === 0 ? 'Last day' : closesIn + 'd left') + '</span>');
    }
    return out.join('');
  }

  function skillsFor(job) {
    var skills = job.skills || [];
    var shown = skills.slice(0, MAX_SKILL_CHIPS).map(function (s) {
      return '<span class="skill">' + escapeHtml(s) + '</span>';
    });
    if (skills.length > MAX_SKILL_CHIPS) {
      shown.push('<span class="skill skill--more">+' +
        (skills.length - MAX_SKILL_CHIPS) + ' more</span>');
    }
    return shown.join('');
  }

  /* Two lines: the site name and pin code lead, because that is what people
     scan for; street, state and country follow underneath. Empty segments
     are dropped rather than leaving stray separators. */
  function addressBlock(job) {
    var a = job.address || {};

    // The name truncates inside the flex row; the pin chip never shrinks.
    var primary = '<span class="u-truncate">' +
      escapeHtml(a.name || job.location || '—') + '</span>';
    if (a.pin) primary += '<span class="job__pin">' + escapeHtml(a.pin) + '</span>';

    var secondary = [a.line1, a.state, a.country]
      .filter(Boolean).map(escapeHtml).join(' &middot; ');

    return '' +
      '<div class="job__address" title="' + escapeHtml(job.addressText || '') + '">' +
        icon(ICONS.pin, 14) +
        '<div class="job__address-text">' +
          '<div class="job__address-primary">' + primary + '</div>' +
          (secondary
            ? '<div class="job__address-secondary u-truncate">' + secondary + '</div>'
            : '') +
        '</div>' +
      '</div>';
  }

  function jobCard(job, index) {
    var slot = SECTOR_ACCENT[job.sector] || 1;
    var isApplied = Object.prototype.hasOwnProperty.call(state.applied, job.id);
    var isSaved = !!state.saved[job.id];
    var flags = badgesFor(job);

    var action = isApplied
      ? '<span class="btn btn--sm btn--applied">' +
          icon('<path d="M20 6 9 17l-5-5"/>', 13) + ' Applied</span>'
      : '<button class="btn btn--sm btn--primary" type="button" data-apply="' +
          escapeHtml(job.id) + '">Apply now ' +
          icon('<path d="M5 12h14M13 6l6 6-6 6"/>', 13) + '</button>';

    /* Sector colours ride down as custom properties: the gradient cap, the
       monogram, the sector pill and the modal header all read from them. */
    var accentVars =
      '--job-accent:var(--sector-' + slot + ');' +
      '--job-accent-2:var(--sector-' + slot + 'b);' +
      '--job-accent-bg:var(--sector-' + slot + '-bg);' +
      '--i:' + index + ';';

    return '' +
      '<article class="job' + (isApplied ? ' job--applied' : '') + '"' +
        ' style="' + accentVars + '">' +

        '<div class="job__head">' +
          '<div class="job__logo" aria-hidden="true">' + escapeHtml(initials(job.employer)) + '</div>' +
          '<div class="job__headings">' +
            '<h3 class="job__title">' + escapeHtml(job.title) + '</h3>' +
            '<div class="job__employer u-truncate">' + escapeHtml(job.employer) + '</div>' +
            '<div class="job__tags">' +
              '<span class="job__sector">' + escapeHtml(job.sector) + '</span>' +
              flags +
            '</div>' +
          '</div>' +
          '<button class="job__save" type="button" data-save="' + escapeHtml(job.id) + '"' +
            ' aria-pressed="' + isSaved + '"' +
            ' aria-label="' + (isSaved ? 'Remove from saved jobs' : 'Save this job') + '">' +
            icon('<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>', 17) +
          '</button>' +
        '</div>' +

        '<div class="job__salary">' +
          '<div>' +
            '<span class="job__salary-figure">' + salaryLabel(job) + '</span> ' +
            '<span class="job__salary-unit">' + (job.salaryMin ? 'per month' : '') + '</span>' +
          '</div>' +
          '<span class="job__exp">' + icon(ICONS.chart, 13) +
            escapeHtml(job.experience) + '</span>' +
        '</div>' +

        addressBlock(job) +

        '<div class="job__facts">' +
          '<span class="fact">' + icon(ICONS.bag, 13) + escapeHtml(job.type) + '</span>' +
          '<span class="fact">' + icon(ICONS.cap, 13) + escapeHtml(job.qualification) + '</span>' +
        '</div>' +

        '<p class="job__desc u-clamp-2">' + escapeHtml(job.description) + '</p>' +

        '<div class="job__skills">' + skillsFor(job) + '</div>' +

        '<div class="job__foot">' +
          '<div class="job__meta">' +
            '<strong>' + job.openings + '</strong> opening' + (job.openings === 1 ? '' : 's') +
            '<br>' + postedLabel(job.posted) +
          '</div>' +
          action +
        '</div>' +
      '</article>';
  }

  function emptyState() {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon">' +
          icon('<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>', 24) +
        '</div>' +
        '<h3 class="empty__title">No jobs match those filters</h3>' +
        '<p class="empty__text">Try a different keyword, widen the location, ' +
          'or clear the employment-type filter to see everything on offer.</p>' +
        '<button class="btn btn--secondary" type="button" id="resetFilters">Clear all filters</button>' +
      '</div>';
  }

  /* Shown when the jobs could not be loaded at all. The message comes from
     the data layer and is deliberately specific — "check the connection"
     tells nobody anything. */
  function errorState(message) {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon">' +
          icon('<circle cx="12" cy="12" r="10"/><path d="M12 8v5m0 3h.01"/>', 24) +
        '</div>' +
        '<h3 class="empty__title">Couldn\'t load jobs</h3>' +
        '<p class="empty__text">' + escapeHtml(message) + '</p>' +
      '</div>';
  }

  function skeletons(count) {
    var out = '';
    for (var i = 0; i < count; i++) out += '<div class="skeleton"></div>';
    return out;
  }

  /* ==========================================================================
     Filtering & sorting
     ========================================================================== */

  function visibleJobs() {
    var q = state.query.trim().toLowerCase();

    var rows = state.jobs.filter(function (job) {
      if (state.type !== 'all' && job.type !== state.type) return false;
      if (state.location !== 'all' && regionOf(job) !== state.location) return false;
      if (state.pincode !== 'all' && pincodeOf(job) !== state.pincode) return false;
      if (!q) return true;

      // addressText covers every address column, so a search for a pin code,
      // street or country matches too.
      var haystack = [
        job.title, job.employer, job.addressText || job.location, job.sector,
        job.qualification, (job.skills || []).join(' ')
      ].join(' ').toLowerCase();

      return haystack.indexOf(q) !== -1;
    });

    return rows.sort(function (a, b) {
      if (state.sort === 'salary') return (b.salaryMax || 0) - (a.salaryMax || 0);
      if (state.sort === 'openings') return (b.openings || 0) - (a.openings || 0);
      if (state.sort === 'closing') {
        return (daysFromToday(a.closes) || 9999) - (daysFromToday(b.closes) || 9999);
      }
      return String(b.posted || '').localeCompare(String(a.posted || ''));
    });
  }

  function render() {
    var rows = visibleJobs();

    el.jobs.innerHTML = rows.length
      ? rows.map(jobCard).join('')
      : emptyState();

    el.resultCount.innerHTML = '<strong>' + rows.length + '</strong> of ' +
      '<strong>' + state.jobs.length + '</strong> jobs';

    el.searchClear.classList.toggle('u-hide', !state.query);
  }

  /* Chip counts and the location dropdown both derive from the loaded set. */
  function renderFilters() {
    var counts = { all: state.jobs.length };
    TYPES.forEach(function (t) { counts[t] = 0; });
    state.jobs.forEach(function (job) {
      if (counts[job.type] !== undefined) counts[job.type]++;
    });

    el.chips.innerHTML = ['all'].concat(TYPES)
      .filter(function (t) { return t === 'all' || counts[t] > 0; })
      .map(function (t) {
        var label = t === 'all' ? 'All jobs' : t;
        return '<button class="chip" type="button" data-type="' +
          escapeHtml(t) + '" aria-pressed="' + (state.type === t) + '">' +
          escapeHtml(label) +
          '<span class="chip__count">' + counts[t] + '</span></button>';
      }).join('');

    var states = state.jobs.map(regionOf)
      .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; })
      .sort();

    el.locationFilter.innerHTML = '<option value="all">All locations</option>' +
      states.map(function (s) {
        return '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>';
      }).join('');
    el.locationFilter.value = state.location;

    renderPincodeOptions();
  }

  /* The pincode list is scoped to whatever state is selected, so the two
     filters can never be combined into an empty result. It is rebuilt
     whenever the state changes, and the current choice is dropped if it no
     longer exists in that scope. Hidden entirely when the report carries no
     pincodes at all, rather than offering a control that does nothing. */
  function renderPincodeOptions() {
    var anyPincode = state.jobs.some(function (job) { return pincodeOf(job); });
    el.pincodeFilter.classList.toggle('u-hide', !anyPincode);
    if (!anyPincode) {
      state.pincode = 'all';
      return;
    }

    var scoped = state.jobs.filter(function (job) {
      return state.location === 'all' || regionOf(job) === state.location;
    });

    var pins = scoped.map(pincodeOf)
      .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; })
      .sort(function (a, b) {
        return a.localeCompare(b, undefined, { numeric: true });
      });

    if (pins.indexOf(state.pincode) === -1) state.pincode = 'all';

    el.pincodeFilter.innerHTML = '<option value="all">All pincodes</option>' +
      pins.map(function (p) {
        return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>';
      }).join('');
    el.pincodeFilter.value = state.pincode;
  }

  function renderStats() {
    var openings = state.jobs.reduce(function (sum, j) { return sum + (j.openings || 0); }, 0);
    var employers = state.jobs.map(function (j) { return j.employer; })
      .filter(function (v, i, arr) { return arr.indexOf(v) === i; }).length;
    var fresh = state.jobs.filter(function (j) {
      var ago = daysSince(j.posted);
      return ago !== null && ago <= 7;
    }).length;

    el.statOpen.textContent = openings.toLocaleString('en-IN');
    el.statEmployers.textContent = employers;
    el.statNew.textContent = fresh;
  }

  /* ==========================================================================
     Apply modal
     ========================================================================== */

  function openModal(jobId) {
    var job = state.jobs.filter(function (j) { return j.id === jobId; })[0];
    if (!job) return;

    state.activeJob = job;
    state.lastFocused = document.activeElement;

    el.modalJobTitle.textContent = job.title;

    /* The employer gets its own line — it comes from the Provider_ID lookup
       and is the thing an applicant most wants confirmed before submitting. */
    el.modalOrgName.textContent = job.employer || '—';

    // The full address here, not the short label — this is the point at which
    // someone decides whether the place is actually reachable for them.
    el.modalJobMeta.textContent = [job.type, job.addressText || job.location]
      .filter(Boolean).join('  ·  ');

    // Give the dialog header the same sector gradient as the card it came from.
    var slot = SECTOR_ACCENT[job.sector] || 1;
    el.modalPanel.style.setProperty('--job-accent', 'var(--sector-' + slot + ')');
    el.modalPanel.style.setProperty('--job-accent-2', 'var(--sector-' + slot + 'b)');

    resetForm();
    el.modalBody.classList.remove('u-hide');
    el.modalFoot.classList.remove('u-hide');

    el.modal.classList.add('is-open');
    document.body.classList.add('is-locked');

    // Focus the first field once the open transition has started.
    window.setTimeout(function () {
      var first = el.applyForm.querySelector('input, select, textarea');
      if (first) first.focus();
    }, 60);
  }

  function closeModal() {
    el.modal.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    state.activeJob = null;
    if (state.lastFocused && state.lastFocused.focus) state.lastFocused.focus();
  }

  function resetForm() {
    // Drop anything a previous open left behind: a success panel, or the
    // embedded Creator form (which would otherwise keep its old prefill).
    var stale = el.modalBody.querySelectorAll('.success');
    Array.prototype.forEach.call(stale, function (node) { node.remove(); });

    el.applyForm.reset();
    el.applyForm.classList.remove('u-hide');
    el.modalBody.scrollTop = 0;
    clearResume();
    Array.prototype.forEach.call(
      el.applyForm.querySelectorAll('.field'),
      function (field) { field.classList.remove('is-invalid'); }
    );
    setSubmitting(false);
  }

  function setSubmitting(isSubmitting) {
    el.submitBtn.disabled = isSubmitting;
    el.cancelBtn.disabled = isSubmitting;
    el.submitBtn.innerHTML = isSubmitting
      ? '<span class="btn__spinner"></span> Submitting…'
      : 'Submit application';
  }

  /* ---- Resume handling -------------------------------------------------- */

  function extensionOf(name) {
    var parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function acceptResume(file) {
    if (!file) return;

    if (RESUME_EXTENSIONS.indexOf(extensionOf(file.name)) === -1) {
      showFieldError('resumeField', 'Use a PDF, DOC or DOCX file.');
      clearResume();
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      showFieldError('resumeField', 'That file is ' + fileSizeLabel(file.size) +
        '. The limit is 5 MB.');
      clearResume();
      return;
    }

    state.resumeFile = file;
    el.fileIcon.textContent = extensionOf(file.name).toUpperCase();
    el.fileName.textContent = file.name;
    el.fileSize.textContent = fileSizeLabel(file.size) + ' · ' +
      extensionOf(file.name).toUpperCase();
    el.dropzone.classList.add('u-hide');
    el.fileCard.classList.remove('u-hide');
    el.resumeField.classList.remove('is-invalid');
  }

  function clearResume() {
    state.resumeFile = null;
    el.resumeInput.value = '';
    el.fileCard.classList.add('u-hide');
    el.dropzone.classList.remove('u-hide');
    el.dropzone.classList.remove('is-dragging');
  }

  /* ---- Validation ------------------------------------------------------- */

  /* Read a control by name. Goes through .elements so a field named
     `location` or `action` cannot collide with a native form property. */
  function val(name) {
    var control = el.applyForm.elements[name];
    return control ? control.value.trim() : '';
  }

  function showFieldError(fieldId, message) {
    var field = document.getElementById(fieldId);
    if (!field) return;
    field.classList.add('is-invalid');
    var slot = field.querySelector('.field__error span');
    if (slot && message) slot.textContent = message;
  }

  function validate() {
    var ok = true;
    var firstBad = null;

    function fail(fieldId, message) {
      showFieldError(fieldId, message);
      if (!firstBad) firstBad = document.getElementById(fieldId);
      ok = false;
    }

    Array.prototype.forEach.call(
      el.applyForm.querySelectorAll('.field'),
      function (field) { field.classList.remove('is-invalid'); }
    );

    if (val('fullName').length < 3) fail('fullNameField', 'Enter your full name.');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val('email'))) {
      fail('emailField', 'Enter a valid email address.');
    }

    // Indian mobile: 10 digits starting 6–9, with an optional +91 / 0 prefix.
    var phone = val('phone').replace(/[\s\-()]/g, '');
    if (!/^(?:\+?91|0)?[6-9]\d{9}$/.test(phone)) {
      fail('phoneField', 'Enter a valid 10-digit mobile number.');
    }

    if (!state.resumeFile) fail('resumeField', 'Attach your resume to continue.');

    if (firstBad) {
      var focusable = firstBad.querySelector('input, select, textarea');
      if (focusable) focusable.focus();
      firstBad.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return ok;
  }

  /* ---- Submit ----------------------------------------------------------- */

  function handleSubmit(event) {
    event.preventDefault();
    if (!validate()) return;

    var job = state.activeJob;
    setSubmitting(true);

    RojgarAPI.submitApplication({
      /* Job_Title and Organization_Name on Apply_For_Job are LOOKUPS, so
         they are written with these record IDs, not the display strings.
         The strings are still passed for the confirmation message. */
      jobId: job.id,
      employerId: job.employerId,
      jobTitle: job.title,
      orgName: job.employer,
      fullName: val('fullName'),
      email: val('email'),
      phone: val('phone'),
      resume: state.resumeFile
    }).then(function (result) {
      state.applied[job.id] = result.reference;
      showSuccess(job, result);
      render();
      toast('Application submitted for ' + job.title + '.', 'good');
    })['catch'](function (error) {
      setSubmitting(false);
      toast('Could not submit — ' + (error && error.message ? error.message :
        'please try again.'), 'error');
    });
  }

  function showSuccess(job, result) {
    el.applyForm.classList.add('u-hide');
    el.modalFoot.classList.add('u-hide');

    var panel = document.createElement('div');
    panel.className = 'success';
    panel.innerHTML =
      '<div class="success__icon">' +
        icon('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>', 30) +
      '</div>' +
      '<h3 class="success__title">Application sent</h3>' +
      '<p class="success__text">Your application for <strong>' +
        escapeHtml(job.title) + '</strong> at ' + escapeHtml(job.employer) +
        ' has been received. The employer will reach out on the number you shared.</p>' +
      '<div class="success__ref">Reference ' + escapeHtml(result.reference) + '</div>' +
      '<button class="btn btn--primary" type="button" data-close-modal>Browse more jobs</button>';

    el.modalBody.appendChild(panel);
    var cta = panel.querySelector('button');
    if (cta) cta.focus();
  }

  /* ==========================================================================
     Toasts
     ========================================================================== */

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'good');
    node.textContent = message;
    el.toasts.appendChild(node);
    window.setTimeout(function () {
      node.style.opacity = '0';
      window.setTimeout(function () { node.remove(); }, 300);
    }, 4200);
  }

  /* ==========================================================================
     Events
     ========================================================================== */

  function bindEvents() {
    // Apply buttons and the empty-state reset are delegated off the grid.
    el.jobs.addEventListener('click', function (e) {
      var applyBtn = e.target.closest('[data-apply]');
      if (applyBtn) { openModal(applyBtn.getAttribute('data-apply')); return; }

      /* Toggle in place rather than re-rendering the grid — a full render
         would replay every card's entrance animation on each bookmark. */
      var saveBtn = e.target.closest('[data-save]');
      if (saveBtn) {
        var id = saveBtn.getAttribute('data-save');
        var nowSaved = !state.saved[id];

        if (nowSaved) state.saved[id] = true;
        else delete state.saved[id];

        saveBtn.setAttribute('aria-pressed', String(nowSaved));
        saveBtn.setAttribute('aria-label',
          nowSaved ? 'Remove from saved jobs' : 'Save this job');
        return;
      }

      if (e.target.closest('#resetFilters')) {
        state.query = '';
        state.type = 'all';
        state.location = 'all';
        state.pincode = 'all';
        el.search.value = '';
        el.locationFilter.value = 'all';
        renderFilters();   // rebuilds the pincode list too
        render();
      }
    });

    el.chips.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-type]');
      if (!chip) return;
      state.type = chip.getAttribute('data-type');
      Array.prototype.forEach.call(el.chips.children, function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
      render();
    });

    el.search.addEventListener('input', function () {
      state.query = el.search.value;
      render();
    });

    el.searchClear.addEventListener('click', function () {
      state.query = '';
      el.search.value = '';
      el.search.focus();
      render();
    });

    el.locationFilter.addEventListener('change', function () {
      state.location = el.locationFilter.value;
      // Narrowing the state can invalidate the chosen pincode, so rebuild.
      renderPincodeOptions();
      render();
    });

    el.pincodeFilter.addEventListener('change', function () {
      state.pincode = el.pincodeFilter.value;
      render();
    });

    el.sortBy.addEventListener('change', function () {
      state.sort = el.sortBy.value;
      render();
    });

    /* ---- Modal --------------------------------------------------------- */

    el.modalClose.addEventListener('click', closeModal);
    el.cancelBtn.addEventListener('click', closeModal);

    // Click on the scrim (but not inside the panel) closes.
    el.modal.addEventListener('click', function (e) {
      if (e.target === el.modal) closeModal();
      if (e.target.closest('[data-close-modal]')) closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !el.modal.classList.contains('is-open')) return;
      if (el.submitBtn.disabled) return;   // don't bail out mid-submit
      closeModal();
    });

    // Keep Tab inside the panel while the dialog is open.
    el.modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var focusables = el.modalPanel.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'
      );
      var list = Array.prototype.filter.call(focusables, function (n) {
        return n.offsetParent !== null;
      });
      if (!list.length) return;

      var first = list[0];
      var last = list[list.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    el.applyForm.addEventListener('submit', handleSubmit);

    // Clear a field's error as soon as the user starts fixing it.
    el.applyForm.addEventListener('input', function (e) {
      var field = e.target.closest('.field');
      if (field) field.classList.remove('is-invalid');
    });

    /* ---- Resume dropzone ------------------------------------------------ */

    el.resumeInput.addEventListener('change', function () {
      acceptResume(el.resumeInput.files && el.resumeInput.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        el.dropzone.classList.add('is-dragging');
      });
    });

    ['dragleave', 'drop'].forEach(function (type) {
      el.dropzone.addEventListener(type, function (e) {
        e.preventDefault();
        el.dropzone.classList.remove('is-dragging');
      });
    });

    el.dropzone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) acceptResume(files[0]);
    });

    el.fileRemove.addEventListener('click', clearResume);
  }

  /* ==========================================================================
     Boot
     ========================================================================== */

  function start() {
    cacheElements();
    bindEvents();

    el.jobs.innerHTML = skeletons(6);

    /* Promise.resolve().then() so that a SYNCHRONOUS throw inside the SDK
       becomes a rejection rather than killing the boot outright — which is
       exactly what a missing ZOHO.CREATOR.init used to do, leaving the
       skeletons up forever with no error anywhere in the UI. */
    Promise.resolve()
      .then(function () { return RojgarAPI.init(); })
      .then(function () { return RojgarAPI.listJobs(); })
      .then(function (result) {
        show(result.jobs, result.warnings);
      })
      ['catch'](function (error) {
        // Never leave the user staring at skeletons.
        var message = (error && error.message) || 'Could not reach Zoho Creator.';
        state.jobs = [];
        el.mockBanner.classList.add('u-hide');
        // Stats stay on their em-dashes: showing 0 would read as "no jobs
        // exist" rather than "we could not ask".
        el.chips.innerHTML = '';
        el.jobs.innerHTML = errorState(message);
        el.resultCount.textContent = '';
        if (window.console) console.error('[Rojgar]', error);
      });
  }

  function show(jobs, warnings) {
    state.jobs = jobs;

    /* The banner now reports fields that could not be matched to the report,
       rather than a sample-data mode — the cards fall back to placeholders
       for each of these, so it is a warning, not a failure. */
    if (warnings && warnings.length) {
      el.bannerText.textContent =
        'Some details could not be resolved, so the cards show placeholders ' +
        'for them: ' + warnings.join(', ') +
        '. Check FIELD_MAP at the top of data.js.';
      el.mockBanner.classList.remove('u-hide');
    } else {
      el.mockBanner.classList.add('u-hide');
    }

    renderStats();
    renderFilters();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
