/* ==========================================================================
   Rojgar — Applicants (employer view)
   --------------------------------------------------------------------------
   Two screens in one page: an organisation sign-in that takes the email and
   mobile registered in All_Details, then every candidate who applied to that
   organisation's openings. All data access goes through
   RojgarAPI.listApplicantsForProvider().
   ========================================================================== */

(function () {
  'use strict';

  var el = {};

  var state = {
    provider: null,
    applicants: [],
    query: '',
    role: 'all'
  };

  function cacheElements() {
    ['lookupCard', 'lookupForm', 'lookupSubmit', 'lookupEmail', 'lookupMobile',
     'resultsSection', 'orgBar', 'orgMark', 'orgName', 'orgMeta', 'changeDetails',
     'filterBar', 'search', 'roleFilter', 'resultCount', 'applicants',
     'statsRow', 'statApplicants', 'statRoles', 'statWeek',
     'toasts'].forEach(function (id) {
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

  function icon(paths, size) {
    var s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  var ICONS = {
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bag: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>'
  };

  function initials(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  /* "2026-09-06" → "6 Sep 2026". Empty for a missing or unparsed date, so
     the caller can drop the line rather than print "Invalid Date". */
  function prettyDate(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function daysSince(iso) {
    if (!iso) return null;
    var then = new Date(iso + 'T00:00:00');
    if (isNaN(then)) return null;
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((now - then) / 86400000);
  }

  function toast(message, kind) {
    var node = document.createElement('div');
    node.className = 'toast toast--' + (kind || 'good');
    node.textContent = message;
    el.toasts.appendChild(node);
    window.setTimeout(function () {
      node.style.opacity = '0';
      window.setTimeout(function () { node.remove(); }, 300);
    }, 4600);
  }

  /* ==========================================================================
     Validation
     ========================================================================== */

  function showFieldError(fieldId, message) {
    var field = document.getElementById(fieldId);
    if (!field) return;
    field.classList.add('is-invalid');
    var slot = field.querySelector('.field__error span');
    if (slot && message) slot.textContent = message;
  }

  function validate() {
    Array.prototype.forEach.call(
      el.lookupForm.querySelectorAll('.field'),
      function (f) { f.classList.remove('is-invalid'); }
    );

    var ok = true;
    var firstBad = null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.lookupEmail.value.trim())) {
      showFieldError('lookupEmailField', 'Enter a valid email address.');
      firstBad = el.lookupEmail;
      ok = false;
    }

    // Indian mobile: 10 digits starting 6–9, with an optional +91 / 0 prefix.
    var mobile = el.lookupMobile.value.replace(/[\s\-()]/g, '');
    if (!/^(?:\+?91|0)?[6-9]\d{9}$/.test(mobile)) {
      showFieldError('lookupMobileField', 'Enter a valid 10-digit mobile number.');
      firstBad = firstBad || el.lookupMobile;
      ok = false;
    }

    if (firstBad) firstBad.focus();
    return ok;
  }

  /* ==========================================================================
     Rendering
     ========================================================================== */

  function skeletons(count) {
    var out = '';
    for (var i = 0; i < count; i++) out += '<div class="skeleton skeleton--row"></div>';
    return out;
  }

  function emptyState(title, message) {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon">' + icon(ICONS.users, 24) + '</div>' +
        '<h3 class="empty__title">' + escapeHtml(title) + '</h3>' +
        '<p class="empty__text">' + escapeHtml(message) + '</p>' +
      '</div>';
  }

  function errorState(message) {
    return '' +
      '<div class="empty">' +
        '<div class="empty__icon">' +
          icon('<circle cx="12" cy="12" r="10"/><path d="M12 8v5m0 3h.01"/>', 24) +
        '</div>' +
        '<h3 class="empty__title">Couldn\'t load applicants</h3>' +
        '<p class="empty__text">' + escapeHtml(message) + '</p>' +
      '</div>';
  }

  function applicantCard(app, index) {
    var job = app.job;
    var applied = prettyDate(app.appliedOn);
    var ago = daysSince(app.appliedOn);
    var isNew = ago !== null && ago <= 3;

    /* mailto/tel are the whole point of this page — an employer wants to
       reach the candidate, not read their details off a screen. */
    var contacts = '';
    if (app.email) {
      contacts += '<a class="contact" href="mailto:' + escapeHtml(app.email) + '">' +
        icon(ICONS.mail, 13) + '<span class="u-truncate">' +
        escapeHtml(app.email) + '</span></a>';
    }
    if (app.mobile) {
      contacts += '<a class="contact" href="tel:' +
        escapeHtml(String(app.mobile).replace(/[^\d+]/g, '')) + '">' +
        icon(ICONS.phone, 13) + escapeHtml(app.mobile) + '</a>';
    }

    return '' +
      '<article class="applicant" style="--i:' + index + '">' +
        '<div class="applicant__avatar" aria-hidden="true">' +
          escapeHtml(initials(app.applicantName)) +
        '</div>' +

        '<div class="applicant__main">' +
          '<div class="applicant__top">' +
            '<h3 class="applicant__name">' +
              escapeHtml(app.applicantName || 'Unnamed applicant') + '</h3>' +
            (isNew ? '<span class="badge badge--new">New</span>' : '') +
          '</div>' +

          '<div class="applicant__role">' +
            icon(ICONS.bag, 13) +
            '<span class="u-truncate">' + escapeHtml(app.jobTitle || 'Role') + '</span>' +
            (job && job.location
              ? '<span class="applicant__place">' + icon(ICONS.pin, 12) +
                escapeHtml(job.location) + '</span>'
              : '') +
          '</div>' +

          '<div class="applicant__contacts">' + contacts + '</div>' +
        '</div>' +

        '<div class="applicant__side">' +
          (applied
            ? '<span class="applicant__when">' + icon(ICONS.clock, 12) + ' ' +
              escapeHtml(applied) + '</span>'
            : '') +
          (app.resume
            ? '<span class="applicant__resume">' + icon(ICONS.file, 12) + ' Resume</span>'
            : '<span class="applicant__resume applicant__resume--none">No resume</span>') +
        '</div>' +
      '</article>';
  }

  function visibleApplicants() {
    var q = state.query.trim().toLowerCase();

    return state.applicants.filter(function (app) {
      if (state.role !== 'all' && (app.jobTitle || '') !== state.role) return false;
      if (!q) return true;
      return [app.applicantName, app.email, app.mobile, app.jobTitle]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function render() {
    var rows = visibleApplicants();

    el.applicants.innerHTML = rows.length
      ? rows.map(applicantCard).join('')
      : emptyState('No matching applicants',
          'Nobody matches that search or role filter.');

    el.resultCount.innerHTML = '<strong>' + rows.length + '</strong> of ' +
      '<strong>' + state.applicants.length + '</strong>';
  }

  function renderRoleFilter() {
    var roles = state.applicants.map(function (a) { return a.jobTitle || ''; })
      .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; })
      .sort();

    el.roleFilter.innerHTML = '<option value="all">All roles</option>' +
      roles.map(function (r) {
        return '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>';
      }).join('');
    el.roleFilter.value = state.role;
  }

  function renderStats() {
    var roles = state.applicants.map(function (a) { return a.jobTitle || ''; })
      .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });

    var thisWeek = state.applicants.filter(function (a) {
      var ago = daysSince(a.appliedOn);
      return ago !== null && ago <= 7;
    });

    el.statApplicants.textContent = state.applicants.length;
    el.statRoles.textContent = roles.length;
    el.statWeek.textContent = thisWeek.length;
    el.statsRow.classList.remove('u-hide');
  }

  function renderProvider(provider) {
    el.orgMark.textContent = initials(provider.name);
    el.orgName.textContent = provider.name;
    el.orgMeta.textContent = [provider.email, provider.mobile]
      .filter(Boolean).join('  ·  ');
  }

  /* ==========================================================================
     Screens
     ========================================================================== */

  function showResults() {
    el.lookupCard.classList.add('u-hide');
    el.resultsSection.classList.remove('u-hide');
  }

  function showLookup() {
    el.resultsSection.classList.add('u-hide');
    el.statsRow.classList.add('u-hide');
    el.filterBar.classList.add('u-hide');
    el.lookupCard.classList.remove('u-hide');

    state.provider = null;
    state.applicants = [];
    state.query = '';
    state.role = 'all';
    el.search.value = '';
    el.lookupEmail.focus();
  }

  function setLoading(isLoading) {
    el.lookupSubmit.disabled = isLoading;
    el.lookupSubmit.innerHTML = isLoading
      ? '<span class="btn__spinner"></span> Checking…'
      : 'View applicants';
  }

  /* ==========================================================================
     Events
     ========================================================================== */

  function handleLookup(event) {
    event.preventDefault();
    if (!validate()) return;

    var email = el.lookupEmail.value.trim();
    var mobile = el.lookupMobile.value.trim();

    setLoading(true);
    el.applicants.innerHTML = skeletons(4);
    el.orgName.textContent = 'Signing in…';
    el.orgMeta.textContent = '';
    el.orgMark.textContent = '';
    showResults();

    RojgarAPI.listApplicantsForProvider(email, mobile)
      .then(function (result) {
        setLoading(false);
        state.provider = result.provider;
        state.applicants = result.applications;

        renderProvider(result.provider);
        renderStats();
        renderRoleFilter();
        render();

        el.filterBar.classList.toggle('u-hide', !state.applicants.length);

        if (result.loadError) {
          /* Signed in, but the applicant list could not be read. Say so
             here rather than claiming nobody applied — those are very
             different things to an employer. */
          el.applicants.innerHTML = errorState(result.loadError);
          toast(result.loadError, 'error');
          return;
        }

        if (!state.applicants.length) {
          el.applicants.innerHTML = emptyState('No one has applied yet',
            'Nobody has applied to your openings so far. Candidates will ' +
            'appear here as soon as they apply.');
        } else {
          toast('Found ' + state.applicants.length + ' applicant' +
            (state.applicants.length === 1 ? '' : 's') + '.', 'good');
        }
      })
      ['catch'](function (error) {
        setLoading(false);
        var message = (error && error.message) || 'Could not reach Zoho Creator.';

        /* Only a sign-in failure goes back to the form. Anything else means
           they ARE signed in, and dumping them on the login screen would
           hide that. */
        if (!error || error.stage === 'signin') {
          showLookup();
          el.lookupEmail.value = email;
          el.lookupMobile.value = mobile;
        } else {
          el.orgName.textContent = 'Signed in';
          el.orgMeta.textContent = '';
          el.applicants.innerHTML = errorState(message);
        }

        toast(message, 'error');
        if (window.console) console.error('[Rojgar]', error);
      });
  }

  function bindEvents() {
    el.lookupForm.addEventListener('submit', handleLookup);

    // Clear a field's error as soon as the user starts fixing it.
    el.lookupForm.addEventListener('input', function (e) {
      var field = e.target.closest('.field');
      if (field) field.classList.remove('is-invalid');
    });

    el.changeDetails.addEventListener('click', showLookup);

    el.search.addEventListener('input', function () {
      state.query = el.search.value;
      render();
    });

    el.roleFilter.addEventListener('change', function () {
      state.role = el.roleFilter.value;
      render();
    });
  }

  function start() {
    cacheElements();
    bindEvents();
    el.lookupEmail.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
