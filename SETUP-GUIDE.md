# Set up your order page: step by step

This guide sets up your own copy of the Supa Juice order system. You need no coding and no special software, just a web browser.

When you are done you will have:

- **An order page** to put in your Instagram bio. Customers order there, see your bank details and get their invoice by email.
- **A private admin page** where you see orders, mark them paid or delivered, and add orders that come in by DM.
- **A Google Sheet** that stores every order. You can open it any time.

It costs nothing to run.

**Time:** about 45 minutes, in one sitting.
**You need:** a Mac with Chrome or Safari, a Google (Gmail) account, and your bank details.

> On a Mac, **⌘** is the **Command** key, next to the space bar. **Right-click** means clicking with two fingers on the trackpad, or holding **Control** while you click.

> Tip: keep a notes app open while you work. You will copy three things into it along the way: your **admin key**, your **web app address** and your **website address**.

---

## Step 1. Download the files

1. Open this link: **https://github.com/supajuice/supajuice.github.io/archive/refs/heads/main.zip**
   It downloads a file called `supajuice.github.io-main.zip`. You do not need an account for this.
2. Open **Finder** and go to **Downloads**. If you see a zip file called `supajuice.github.io-main.zip`, double-click it to unzip it. (Safari often unzips it for you, so the folder may already be there.)
3. You now have a folder called `supajuice.github.io-main`. Inside it are two folders you will use:
   - `apps-script`: the part that runs inside Google
   - `docs`: the website

---

## Step 2. Create the Google Sheet

1. Go to **https://sheets.new**. A new, empty Google Sheet opens. Sign in with your Google account if asked.
2. Click **Untitled spreadsheet** at the top left and rename it to **Supa Juice Orders**.
3. In the menu, click **Extensions**, then **Apps Script**. A new tab opens with a code editor.

### Paste in the code

4. In the editor you will see a file called `Code.gs` with a few lines in it. Click inside that text, press **⌘ + A** to select it all, and press **Delete**.
5. In Finder, open `supajuice.github.io-main` → `apps-script`. Right-click **Code.gs** → **Open With** → **TextEdit**.
   (If TextEdit is not in the list, choose **Other…**, pick **TextEdit**, and click **Open**.)
6. In TextEdit press **⌘ + A**, then **⌘ + C** to copy everything.
7. Go back to the Apps Script tab, click in the empty editor and press **⌘ + V** to paste.
8. Press **⌘ + S** to save. (Or click the disk icon.)

### Set the time zone

This makes order times show in South African time.

9. On the far left of the Apps Script page, click the **gear icon** (Project Settings).
10. Tick **Show "appsscript.json" manifest file in editor**.
11. Click the **< >** icon on the far left to go back to the editor. A file called `appsscript.json` now shows in the file list. Click it.
12. Select everything in it (**⌘ + A**) and delete it.
13. In Finder, open `apps-script`, then right-click **appsscript.json** → **Open With** → **TextEdit**. Copy everything (**⌘ + A**, then **⌘ + C**) and paste it into the editor (**⌘ + V**).
14. Press **⌘ + S** to save.

### Run the setup

15. Click **Code.gs** in the file list again.
16. At the top of the editor there is a drop-down menu next to the **Run** button. Choose **setup** from it.
17. Click **Run**.
18. Google now asks for permission. This is normal: the code is yours and only works with your own sheet and email.
    1. Click **Review permissions** and choose your Google account.
    2. You will see **"Google hasn't verified this app"**. Click **Advanced**, then **Go to Untitled project (unsafe)**.
    3. Click **Allow**.
19. Wait a few seconds. An **Execution log** appears at the bottom. Find the line that starts with **Admin key:**.
20. **Copy the long code after "Admin key:" into your notes.** This is the password for your admin page. Do not share it.

> Lost the key later? Choose **showAdminKey** in the same drop-down and click **Run**. The key appears in the log again.

Go back to your Google Sheet tab. It now has two tabs at the bottom: **Orders** and **Settings**. Leave them as they are.

---

## Step 3. Turn the script into a web app

This gives your website an address it can send orders to.

1. In the Apps Script tab, click the blue **Deploy** button (top right), then **New deployment**.
2. Next to **Select type**, click the **gear icon** and choose **Web app**.
3. Fill in:
   - **Description:** `Orders`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**. Be careful here: choose **Anyone**, *not* "Anyone with Google account". Your customers are not signed in to Google.
4. Click **Deploy**. If Google asks for permission again, allow it as before.
5. You will see a **Web app URL**. It starts with `https://script.google.com/macros/s/` and ends with `/exec`. Click **Copy** and **put it in your notes.**
6. Click **Done**.

**Check it works:** paste that web app address into a new browser tab and press Enter. You should see:

```
{"ok":true,"service":"orders"}
```

If you see a Google sign-in page instead, "Who has access" is not set to **Anyone**. Fix it under **Deploy → Manage deployments → pencil icon**.

---

## Step 4. Create a free GitHub account

GitHub will host your website for free.

1. Go to **https://github.com/signup**.
2. Enter your email, a password and a **username**.
   Pick the username with care: it becomes part of your website address. For example, the username `supajuice` gives `https://supajuice.github.io/...`.
3. Finish the puzzle, then enter the code GitHub emails you.
4. If GitHub asks questions about how you will use it, you can skip them.

---

## Step 5. Put the website on GitHub

### Create a place for the files

1. Once signed in to GitHub, click the **+** at the top right, then **New repository**.
2. **Repository name:** `shop` (or any short name with no spaces. It also becomes part of your website address.)
3. Choose **Public**. Free websites need this. Nothing private goes in it: your bank details live in the Google Sheet, not here.
4. Leave everything else as it is and click **Create repository**.

### Upload the website files

5. On the next page, find the line **"…or upload an existing file"** and click **uploading an existing file**.
6. In Finder, open `supajuice.github.io-main` → **`docs`**. You should see files like `index.html`, `admin.html`, `config.js` and a `fonts` folder.
7. Click inside that Finder window, press **⌘ + A** to select everything **inside** the `docs` folder, and drag it all onto the GitHub page where it says **Drag files here**.
   Upload what is *inside* `docs`, not the `docs` folder itself.
   Tip: put the Finder window and the browser side by side first, so you can drag from one to the other.
8. Wait until all files are listed (about 8 files and the fonts folder).
9. Scroll down and click the green **Commit changes** button.

### Connect the website to your Google script

10. In the file list, click **config.js**.
11. Click the **pencil icon** (Edit this file) at the top right of the file.
12. Find this line:
    ```
    endpoint: 'PASTE_THE_WEB_APP_ADDRESS_HERE',
    ```
    Replace `PASTE_THE_WEB_APP_ADDRESS_HERE` with your **web app address** from Step 3. Keep the quote marks around it. The line should look like this:
    ```
    endpoint: 'https://script.google.com/macros/s/AKfy...long code.../exec',
    ```
    (If the file already has another web app address there, replace that one with yours.)
13. On the next line, put your Instagram handle **without the @** between the quotes. For example:
    ```
    instagram: 'supajuice.za'
    ```
    Customers see it as a "send us a DM" link if something goes wrong.
14. Click **Commit changes…** (top right), then **Commit changes** again.

### Switch the website on

15. Click the **Settings** tab at the top of your repository page (the one with the gear icon).
16. In the left menu, click **Pages**.
17. Under **Build and deployment**:
    - **Source:** Deploy from a branch
    - **Branch:** choose **main**, leave the folder on **/ (root)**, and click **Save**.
18. Wait 1 to 2 minutes, then refresh the page. At the top it will say **"Your site is live at …"**. That is your **order page address**, for example:
    `https://supajuice.github.io/shop/`
    **Put it in your notes.**

---

## Step 6. Open your admin page and fill in your details

1. Your admin page address is your order page address, then `admin.html#`, then your admin key. For example:
   ```
   https://supajuice.github.io/shop/admin.html#3f9a1c...your admin key...
   ```
   Build this in your notes, then open it in your browser.
2. **Bookmark it**, on your computer and on your phone. It is your private login link, so treat it like a password and do not share it.
3. Tap the **Settings** tab and fill in:
   - **Price per sachet**, e.g. `40`
   - **Delivery fee**: `0` for free delivery
   - **Delivery area**, e.g. `Cape Town`
   - **Bank**, **Account holder**, **Account number**, **Branch code**, **Account type**
   - **Email me new orders**: your own email. You get an email for every new order.
4. Tap **Save settings**. You should see **"Settings saved. Your order page is open."**

> Until the price and bank details are filled in, the order page says "Ordering opens soon".

---

## Step 7. Place a test order

1. On your phone, open your order page address.
   For a real test, send the link to yourself in an Instagram DM and tap it there.
2. Order 1 sachet using **your own name and email**. You should see an invoice number like **SJ-0001** and your bank details.
3. Check your email. You should have:
   - a **"New order"** alert, and
   - an email with the **invoice PDF** attached. Look in spam if it is not there.
4. Open your admin page. The order is under **Awaiting payment**. Tap **Mark paid**, then **Yes, mark paid**. A **paid** invoice PDF arrives by email.
5. Try **Mark delivered** too.

### Clear the test before going live

6. In your Google Sheet, open the **Orders** tab. Select the test order rows (not row 1, the headings), right-click, and choose **Delete rows**.
7. In the Apps Script tab, choose **resetNumbering** in the drop-down and click **Run**. Your first real order will now be **SJ-0001**.

---

## Step 8. Go live

Put your **order page address** in your Instagram bio. That's it, you're open.

---

## Everyday use

| When this happens | Do this |
| --- | --- |
| **A delivery request comes in** | You get an email alert. It shows under **New requests**. Type the delivery fee for that address and tap **Accept and email invoice**. The customer then gets the invoice with the bank details. Or **More** → **Decline**. |
| **A collection order comes in** | It shows under **Awaiting payment** with the day and time the customer picked. The customer already has the bank details and their invoice PDF. When you mark it paid, they also get a calendar invite. |
| **Move a paid collection** | On the order, tap **More** → **Change collection time**. The customer is emailed an updated calendar invite. |
| **Someone orders by DM** | Admin page → **New order**. Enter the quantity and their name (email optional), then tap **Create order**. Tap **Copy invoice** and paste it into the DM. |
| **Money arrives** | Find the invoice number (e.g. SJ-0004) in your bank statement reference. Tap **Mark paid** on that order. The customer is emailed the paid invoice. |
| **You delivered** | Tap **Mark delivered**. Tap an address to open it in Maps. |
| **Collection times** | Admin page → **Settings** → **Collection**: the place, the dates (tick them on a calendar of the next 30 days), the hours, the length of each time, and how many customers per time. Tick new dates as the weeks go by. |
| **Change an order before it is paid** | Tap **Edit** on the order. Change anything, including the price or fee, then **Save changes**. The customer is emailed the new invoice unless you untick it. |
| **Customer lost the email** | On the order tap **More** → **Email invoice**. |
| **You made a mistake** | **More** → **Undo paid**, **Undo delivered** or **Cancel order**. A cancelled order can be reopened. |
| **Change price or bank details** | Admin page → **Settings**. Orders already placed keep their old price. |
| **Add a photo to the order page** | Admin page → **Settings** → **Order page photo** → **Add photo**. Pick one from your phone and add a short description. |

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Order page says **"This page is not connected yet"** | `config.js` on GitHub still has the placeholder. Redo Step 5, "Connect the website". |
| Order page says **"We could not load the order form"** | Open your web app address in a browser. If you see a Google sign-in page, set **Who has access** to **Anyone** (Step 3). Check the address in `config.js` ends in `/exec`. |
| Order page says **"Ordering opens soon"** | Fill in the price and bank details in **Settings** on your admin page. |
| Admin page says **"That admin key is not right"** | Run **showAdminKey** in Apps Script and rebuild your admin link with that key. |
| GitHub shows a 404 page | Wait 2 minutes after Step 5 and refresh. Check you uploaded what is *inside* `docs` (you should see `index.html` in the file list, not a `docs` folder). |
| No emails arrive | Check spam. Check **Email me new orders** in Settings. A free Gmail account can send about 100 emails a day. |
| Order times are wrong | Redo "Set the time zone" in Step 2, then do the "Getting an update" steps below. |

---

## Keep it safe

- **Your admin key** opens your admin page. Only you should have it.
- **If you lose your phone or the key leaks:** in Apps Script choose **rotateAdminKey** and click **Run**. The old key stops working, and the log shows the new one. Make a new admin link with it.
- **Do not share the Google Sheet.** It has your customers' names, emails and addresses.

## Getting an update

If you are sent a new `Code.gs`:

1. Apps Script → `Code.gs` → select all, delete, paste the new code, **⌘ + S**.
2. Choose **setup** and click **Run**. It keeps your orders, settings and key.
3. Click **Deploy → Manage deployments**, click the **pencil icon**, set **Version** to **New version**, and click **Deploy**.

Your web app address stays the same, so you do not need to change anything on GitHub.
