# Gmail OAuth 2.0 Setup Guide

This guide walks you through setting up Google Cloud OAuth 2.0 credentials for the **AI Job Outreach Agent**.

---

## 1. Create a Google Cloud Project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown at the top of the page and select **New Project**.
3. Name your project (e.g., `ai-job-outreach-agent`) and click **Create**.
4. Once created, ensure the new project is selected in the top bar.

---

## 2. Enable the Gmail API

1. In the Google Cloud Console search bar, search for **Gmail API**.
2. Click on **Gmail API** from the Marketplace / API Library results.
3. Click the **Enable** button.

---

## 3. Configure the OAuth Consent Screen

1. In the left navigation menu, go to **APIs & Services** > **OAuth consent screen**.
2. Select **External** (standard for personal projects and Google accounts) and click **Create**.
3. Fill in the required fields:
   - **App name**: `AI Job Outreach Agent`
   - **User support email**: Select your own Gmail address
   - **Developer contact information**: Enter your email address
4. Click **Save and Continue**.
5. **Scopes**:
   - Click **Add or Remove Scopes**.
   - Search for `https://www.googleapis.com/auth/gmail.send`.
   - Select the checkbox for `gmail.send` (Send messages on your behalf).
   - Click **Update**, then **Save and Continue**.
6. **Test Users**:
   - Because your app is in "Testing" mode, only explicitly authorized Google accounts can log in.
   - Click **Add Users** and add your Gmail address (the account you will use to send outreach emails).
   - Click **Save and Continue**.
7. Review your summary and click **Back to Dashboard**.

---

## 4. Create OAuth 2.0 Credentials

1. In the left navigation menu, go to **APIs & Services** > **Credentials**.
2. Click **+ Create Credentials** at the top and choose **OAuth client ID**.
3. Under **Application type**, select **Web application**.
4. Set the **Name** to `AI Outreach Web Client`.
5. Under **Authorized redirect URIs**, click **+ Add URI** and enter:
   ```
   http://localhost:3000/api/gmail/callback
   ```
   *(If deploying to production, add your production domain's callback URL, e.g., `https://your-domain.com/api/gmail/callback`)*.
6. Click **Create**.
7. A dialog will appear displaying your **Client ID** and **Client Secret**. Copy these values.

---

## 5. Configure Your Local Environment

1. In the project root, open or create `.env.local`:
   ```bash
   # Google OAuth 2.0 Credentials
   GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your_client_secret_here
   GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/callback

   # AES-256-GCM Token Encryption Key (generate a random 32-character or hex key)
   ENCRYPTION_KEY=your_strong_32_byte_secret_key_here
   ```

2. Generate a secure encryption key using Node.js:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Paste the output as your `ENCRYPTION_KEY`.

---

## 6. Connect Gmail and Verify

1. Start your development server:
   ```bash
   npm run dev
   ```
2. Navigate to `http://localhost:3000/settings`.
3. In the **Gmail Connection** card, click **Connect Gmail**.
4. You will be redirected to Google's consent screen:
   - Select your test user account.
   - You may see a screen saying *"Google hasn't verified this app"*. Click **Advanced**, then **Go to AI Job Outreach Agent (unsafe)**.
   - Review permissions and click **Allow**.
5. Google will redirect back to `/settings?gmail=connected`.
6. You should now see:
   - **Connected** status badge.
   - Your authorized Gmail address displayed.
7. Test the connection:
   - Enter your email address into the **Send Test Email** input.
   - Click **Send Test Email**.
   - Check your inbox: you should receive the integration test email with your active resume PDF attached!

---

## 7. Railway Production Deployment Configuration

When running in Railway production (`https://ai-job-outreach-agent-production.up.railway.app`):

### 1. Update Google Cloud Console Authorized Redirect URIs
In **APIs & Services** > **Credentials** > Click your OAuth 2.0 Web Client:
Under **Authorized redirect URIs**, ensure you have added:
```
https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback
```
*(Also keep `http://localhost:3000/api/gmail/callback` for local development).*

### 2. Railway Environment Variables
In your Railway Service **Variables** tab, set:
```env
NEXT_PUBLIC_APP_URL=https://ai-job-outreach-agent-production.up.railway.app
GMAIL_REDIRECT_URI=https://ai-job-outreach-agent-production.up.railway.app/api/gmail/callback
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your_actual_client_secret
```

### 3. Troubleshooting `invalid_client` Error
If Google returns `invalid_client`:
- **API Key vs Client Secret**: Verify that `GOOGLE_CLIENT_SECRET` is your **OAuth 2.0 Client Secret** (which begins with `GOCSPX-`), and **NOT** a Google Cloud API Key (which begins with `AIzaSy`).
- **Matching Credentials**: Verify that the Client Secret was generated for the exact same Client ID in the Google Cloud Console.
- **Client Type**: Ensure the OAuth client was created as a **Web application** (not Desktop, Android, or iOS).
- **No Quotes**: Ensure the value in Railway does not have literal quotation marks or leading/trailing spaces.
