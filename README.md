# Supa Juice orders

> **Setting this up for yourself, without any coding?** Follow **[SETUP-GUIDE.md](SETUP-GUIDE.md)**. It needs only a web browser.

Orders and invoices for a one-product running gel business.

- Customers order from a page linked in the Instagram bio, see the bank details and get an invoice number. The invoice is also emailed to them as a PDF.
- Greg can also enter an order himself when someone sends a DM, then paste the invoice into the chat. If he adds their email, they get the PDF too.
- Payment is by bank transfer. Greg checks his bank statement and marks the order paid. The paid invoice is emailed automatically, and he can paste it into the DM as well.
- Everything is stored in a Google Sheet. No monthly cost.

```
Instagram bio  ->  Order page (GitHub Pages)  ->  Apps Script web app  ->  Google Sheet
                   Greg's page (GitHub Pages) ->  (same web app, needs the admin key)
```

| File | What it is |
| --- | --- |
| `docs/index.html` | The order page customers use |
| `docs/admin.html` | Greg's page: orders, new DM order, settings |
| `docs/config.js` | The one file you edit on the website side: the web app address |
| `apps-script/Code.gs` | The backend. Pasted into the Google Sheet's script editor |
| `apps-script/appsscript.json` | Time zone and web app defaults (optional, see step 4) |
| `tests/` | Automated tests, and a fake service for trying the pages locally |

## Set up (about 20 minutes)

You need a Google account and a GitHub account. For now everything runs under yours. Moving it to Greg's accounts later is covered at the end.

### Part 1: the Google Sheet and script

1. Go to [sheets.new](https://sheets.new) and name the sheet **Supa Juice Orders**.
2. Open **Extensions > Apps Script**.
3. Delete what is in `Code.gs`, paste in the whole of `apps-script/Code.gs`, and save.
4. Set the time zone, so order times are Cape Town times. Click the gear (**Project Settings**), tick **Show "appsscript.json" manifest file in editor**, go back to the editor, open `appsscript.json`, replace its contents with `apps-script/appsscript.json`, and save.
5. In the function list at the top choose **setup** and click **Run**.
   - Google asks for permission the first time. Choose your account, then **Advanced**, then **Go to (project name) (unsafe)**, then **Allow**. This is your own script. It needs the sheet, and permission to send the order alert email.
   - When it finishes, open the **Execution log** at the bottom. The line `Admin key: ...` is Greg's password for his page. Copy it somewhere safe. You can show it again by running `showAdminKey`.
   - Two tabs now exist in the sheet: **Orders** and **Settings**.
6. Click **Deploy > New deployment**. Click the gear next to "Select type" and choose **Web app**. Set:
   - Execute as: **Me**
   - Who has access: **Anyone** (not "Anyone with Google account": customers are not signed in)
   
   Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.
7. Check it: open that URL in a browser tab. You should see `{"ok":true,"service":"orders"}`. If you see a Google sign-in page instead, "Who has access" is not set to Anyone.

### Part 2: the website on GitHub Pages

1. Open `docs/config.js`. Paste the web app URL between the quotes after `endpoint:`. Optionally put Greg's Instagram handle (without the @) after `instagram:`; the order page shows it as a "send us a DM" fallback when something goes wrong.
2. Create a GitHub repository, for example `supa-juice`. It has to be public for free GitHub Pages. Nothing secret is in it: the web app address is public by design, and the admin key is never stored in the code.
3. Push this folder to it:
   ```
   git init
   git add .
   git commit -m "Supa Juice orders"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/supa-juice.git
   git push -u origin main
   ```
4. On GitHub open **Settings > Pages**. Under **Build and deployment** choose **Deploy from a branch**, pick branch `main` and folder `/docs`, and save. After a minute the site is live at `https://YOUR-NAME.github.io/supa-juice/`.

### Part 3: Greg's first run

1. Open Greg's private link on his phone. It is the site address plus `admin.html#` plus the admin key:

   `https://YOUR-NAME.github.io/supa-juice/admin.html#PASTE-THE-ADMIN-KEY-HERE`

   The page remembers the key on that phone and removes it from the address bar. Save the full link as a bookmark: it always works, even if the phone clears the page's memory. Treat the link like a password.

   A home screen icon works too, but on an iPhone the icon keeps its own separate memory, so the first time it asks for the key: paste it in once.
2. Open **Settings**. Fill in the price, the delivery fee (0 for free), the delivery area, the bank details and the email address for new-order alerts. Save. You will see "Settings saved. Your order page is open."
   - Until the price and the bank name, account holder and account number are set, the order page shows "Ordering opens soon".
   - The Settings screen also shows the order page link to put in the Instagram bio.

### Part 4: test it before the bio link goes live

I could not test against a live Google deployment from here, so please do this once.

1. On a phone, open the order page from inside Instagram (send the link to yourself in a DM and tap it). Instagram's built-in browser is the strictest place it will run.
2. Place a test order for yourself. You should see an invoice number such as SJ-0001 and the bank details.
3. Open Greg's page. The order is under **Awaiting payment**. Try **Mark paid**, **Copy invoice**, **Mark delivered**.
4. Create a DM order from the **New order** tab, then copy its invoice.
5. Clean up. In the sheet, delete the test rows in the **Orders** tab (keep the header row). In the script editor run `resetNumbering`. The next real order is SJ-0001.
6. Put the order page link in the Instagram bio.

If step 2 shows "We could not load the order form", see the troubleshooting table below.

## Greg's cheat sheet

**An order comes in from the order page.** It shows under **Awaiting payment** and an alert email is sent. The customer has the bank details and an invoice number to use as the payment reference, and the invoice PDF in their email.

**An order comes in by DM.** Open **New order**, enter the quantity and the customer's name (the rest is optional), and tap **Create order**. Tap **Copy invoice** and paste it into the DM. It has the bank details and the reference. If you filled in their email, the PDF is emailed as well.

**Money arrives.** Find the invoice number in the bank statement reference. In the app tap **Mark paid** on that order, then **Yes, mark paid**. If the order has an email address, the paid invoice PDF is emailed straight away. The order moves to **Paid** with a **Copy invoice** button, so you can paste the paid invoice into the DM too.

**A photo on the order page.** **Settings > Order page photo > Add photo** and pick one from the phone. It is made smaller on the phone first, then shows above the order form. **Replace photo** swaps it, **Remove photo** takes it off. Add a short description for customers who use a screen reader.

**Customer cannot find the email.** Tap **More** on the order, then **Email invoice**. It sends the invoice as it is now: unpaid with bank details, or paid. The order shows when the invoice was last emailed. To add or fix an email address, edit the **Email** column in the sheet.

**Delivered.** Tap **Mark delivered** on the order under **Paid**. Tap an address to open it in Maps and a phone number to call.

**Collection.** Write a collection note in **Settings > Collection**, for example "Sea Point. We DM you to arrange a time." The order page then offers **Delivery** or **Collect, free**. Collection orders have no delivery fee and no address, the invoice tells the customer where to collect, and the button reads **Mark collected**. Leave the note blank to offer delivery only. For a DM order, tick **Customer collects**.

**Changing an order.** Tap **Edit** on an order under **Awaiting payment**. Everything can be changed: name, email, contact, quantity, collection, address, notes, and the price and delivery fee for that order (for example a discount). The invoice number stays the same and the total is worked out again. Leave **Email the updated invoice** ticked to send the customer the new PDF. Paid orders cannot be edited: tap **More > Undo paid** first.

**Mistakes.** Tap **More** on an order: **Undo paid**, **Undo delivered**, **Cancel order**. A cancelled order can be reopened.

**Underpaid.** Partial payments are not tracked. Leave the order under **Awaiting payment** until the full amount arrives.

| Status | Meaning | Next step |
| --- | --- | --- |
| Awaiting payment | Ordered, no money yet | Mark paid, or Cancel |
| Paid | Money received | Mark delivered |
| Delivered | Done | None |
| Cancelled | Will not happen | Reopen if needed |

## Changing things later

- **Price, delivery fee, bank details, brand, alert email:** the **Settings** tab on Greg's page. Orders already placed keep the price they were placed at.
- **The same settings in the sheet:** the **Settings** tab of the Google Sheet works too. The page is safer because it checks what you type.
- **Changing `Code.gs`:** paste the new code, save, and run `setup` once more (it keeps your settings, key and orders, and adds any new columns). Then choose **Deploy > Manage deployments**, click the pencil, set **Version** to **New version**, and **Deploy**. The web app address stays the same. Without this step the live service keeps running the old code. If Google asks for permission again, allow it as in Part 1.
- **If the admin key leaks or Greg loses his phone:** run `rotateAdminKey` in the script editor. The old link stops working. Give Greg the new key and link.
- **Invoice prefix:** `SJ` by default, changeable in Settings. Numbers always continue; a number is never reused, even if you delete rows.

## Moving it to Greg's accounts

Nothing is tied to your accounts except where the pieces live, so moving is a few steps:

1. Share the sheet with Greg. He opens it and chooses **File > Make a copy**. The script comes with the copy, and so do the orders. (Or repeat Part 1 from scratch and paste the old rows into **Orders**.)
2. In the copy open **Extensions > Apps Script**, run `setup` (this creates a new admin key) and deploy as a web app again (Part 1, step 6). Alert emails will then come from his account.
3. Put the new web app address into `docs/config.js`.
4. Move the site: transfer the GitHub repository to Greg, or have him create his own and push the folder (Part 2).
5. Use the new admin link. The old key and link stop working when you switch the address.

## How it works

- **Order page and Greg's page** are plain static files. No build step, no framework.
- **The backend** is one Apps Script file bound to the sheet. The pages send it JSON with `fetch`. The body is sent as plain text so the browser does not need a CORS preflight request, which Apps Script cannot answer.
- **The sheet is the database.** The **Orders** tab has one row per order. Greg can read it, filter it or export it any time.
- **Money is worked out on the server**, in whole cents. The page shows a total, and if the price changed in the meantime the server refuses the order and the customer sees the new total first.
- **Invoice numbers** are sequential (SJ-0001, SJ-0002, ...). They are handed out under a lock, so two orders at the same moment never get the same number.
- **Double taps and retries** do not create duplicate orders. Each order carries a request id, and the same id returns the order that already exists.
- **Admin actions** need the admin key. Customers never see it, and the bank details are only returned to someone who has just placed an order, or to Greg.
- **Customer text** is never trusted: it is shown as plain text, length-limited, and stored so Sheets cannot read it as a formula.
- **Spam:** the order page has a hidden field that bots fill in, and accepts at most 12 orders an hour. Orders Greg enters himself are not limited.
- **Invoice emails** are made on the server: the invoice is written as a page and Apps Script turns it into a PDF. They come from the Google account that deployed the script, show the brand name as the sender, and replies go to the **Email me new orders** address. A failed email never fails the order; it shows as an invoice that was not emailed, and **Email invoice** tries again.
- **The order page photo** is kept in a hidden **Photo** tab of the sheet, as text split over a few cells (one cell holds at most 50,000 characters). That way no Google Drive permission is needed. Leave that tab alone; change the photo from the admin page. Each phone downloads a photo once and keeps it until it is replaced.
- **Email limits:** a free Google account can send to about 100 addresses a day. Each order from the order page uses two (Greg's alert and the customer's invoice), and marking it paid uses one more. That is plenty for a small shop. A Google Workspace account allows 1,500.

### Not included, on purpose

One product only. No stock counts. No card payments. No automatic bank matching. No refunds or partial payments. No email reminders for unpaid orders. Fake orders from the order page are possible; they sit under **Awaiting payment** and can be cancelled. Someone could type a stranger's email into the order page, who would then get one invoice email; the hourly cap limits this.

### Privacy

The sheet holds customers' names, contacts, email addresses and delivery addresses. Do not share the sheet. Share only the admin link, and only with the person who runs the orders.

## Troubleshooting

| What you see | Why | Fix |
| --- | --- | --- |
| Order page: "This page is not connected yet" | `docs/config.js` still has the placeholder | Paste the web app address into `config.js` and push |
| Order page: "We could not load the order form" | Wrong address, or "Who has access" is not Anyone | Open the address in a browser tab. You should see `{"ok":true,...}`. The address must end in `/exec` |
| Order page: "Ordering opens soon" | Price or bank details are missing | Fill them in under **Settings** |
| Greg's page: "That admin key is not right" | Wrong key, or it was rotated | Run `showAdminKey` in the script editor and use that key |
| Greg's page: "Orders did not load" | No connection, or the service is down | Tap **Try again**. Check the web app address opens in a browser |
| A code change has no effect | The live web app still runs the old version | **Deploy > Manage deployments > pencil > New version** |
| Times are wrong | The script time zone | Use `apps-script/appsscript.json` (Part 1, step 4) |
| No alert emails | Email blank or mistyped, or in spam | Check **Settings > Email me new orders**. Mail comes from the Google account that deployed the script |
| A customer got no invoice email | Spam folder, a mistyped address, or the daily email limit | Ask them to check spam. Check the **Email** column. Then **More > Email invoice**. If it says it could not be sent, try again tomorrow |
| Orders have no **Email** column | `setup` was not run after updating `Code.gs` | Run `setup` once. It adds the columns and keeps everything else |
| Copy invoice does nothing | The in-app browser blocks copying | The invoice text is shown on the screen. Press and hold to select it |

## Trying it on your computer

The tests run the real `Code.gs` against pretend Google services, and the real pages in a real browser.

You need Node 20 or newer.

```
npm install
npx playwright install chromium
npm test
```

`npm run test:server` runs only the backend tests and needs nothing installed.

`npm run dev` starts a local copy of both pages with sample orders and prints the links to open. Nothing is saved, and nothing talks to Google.
