/* ==========================================================================
   Rojgar — configuration template
   --------------------------------------------------------------------------
   Copy this to config.js and fill in the keys. config.js is gitignored: the
   permalink keys grant login-free read access to organisation contacts and
   to applicants' names, emails and phone numbers, so they must not be
   committed to a public repository.

   Each key is the alphanumeric part at the END of that component's published
   permalink. Publish the component in Creator first (Share > Publish), then
   copy from its URL:

     .../report-perma/All_Details/VHyXCHPxKBChG0mk...
                      ^component   ^the key

   Note applicationForm uses form-perma, not report-perma.

   Only needed for a PUBLISHED page. On a normal signed-in Creator page the
   widget uses the DATA APIs and needs none of this.
   ========================================================================== */

window.ROJGAR_CONFIG = {
  publicLinks: {
    jobsReport: '',          // report-perma/All_Job_Openings/<key>
    providersReport: '',     // report-perma/All_Details/<key>
    applicationsReport: '',  // report-perma/Apply_For_Job_Report/<key>
    applicationForm: ''      // form-perma/Apply_For_Job/<key>
  }

  // Anything else from CREATOR in data.js can be overridden here too, e.g.
  //   publicPage: true,
  //   jobsCriteria: 'Status == "Open"'
};
