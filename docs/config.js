// Connects these pages to the order service. This is the only file you edit on the website side.
//
// endpoint   The Web app address from Apps Script (Deploy > Manage deployments).
//            It starts with https://script.google.com/macros/s/ and ends with /exec
// instagram  Optional. An Instagram handle without the @. Shown as a fallback when
//            ordering is closed or busy, so customers know where to send a DM.
window.SJ_CONFIG = {
  endpoint: 'PASTE_THE_WEB_APP_ADDRESS_HERE',
  instagram: ''
};
