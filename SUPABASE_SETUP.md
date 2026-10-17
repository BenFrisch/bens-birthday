# Supabase setup

Ben's World uses a single shared Supabase Auth account, a private Storage bucket, and one shared database row for editable trip data. Public sign-ups must remain disabled.

## Configure the project

1. In Supabase Authentication settings, disable new user sign-ups and create the shared email/password user.
2. Open **SQL Editor**, paste and run [`supabase/schema.sql`](./supabase/schema.sql). This creates the shared-state table, private `family-photos` bucket, access policies, and realtime publication.
3. In **Authentication → URL Configuration**, add the deployed site URL to the allowed redirect URLs. Also add the local development URL if you use one.
4. Confirm [`supabase-config.js`](./supabase-config.js) contains the Project URL and publishable key. Those values are intended to be public. Never add the database password, a secret key, or the service-role key to this repository.
5. Deploy the complete site over HTTPS. The site must be served from a web server; opening `index.html` directly from the file system will not work reliably.
6. Sign in and test the application. Uploads are resized to at most 2048 pixels on the longest side, converted to WebP at quality 0.8, and uploaded to private Storage. Available EXIF capture dates and GPS coordinates are saved as photo metadata. If an upload has no GPS data, the app asks for latitude and longitude in decimal degrees; choose **Skip** to continue without coordinates. Photos with GPS show an **Open photo location in Street View** link in the full-size photo view and center the detailed map on that photo. Google Street View availability depends on Google coverage at those coordinates. HEIC conversion requires the external libraries loaded by the page and an internet connection.

The app imports any existing trip, country, and edit data from the browser used for its first sign-in if the shared cloud record does not exist. Once cloud data exists, it becomes the source of truth; local browser data is only a working cache. Data saved only in another browser must be exported or entered there before it is lost.

## Move the built-in photos to private Storage

After signing in, choose **Move built-in photos to private storage**. Keep the page open while it converts and uploads the existing destination photos. The app saves the mapping in Supabase so later devices use signed links to the private copies.

Once you have verified the album on a second device, remove the old `.jpg` destination images from the deployed site's `assets/images/` directory and redeploy. The two `.png` branding images are still used by the birthday screen and logo. Until those public `.jpg` files are removed from the deployed site, anyone who knows their URLs can still fetch those originals without signing in. If the Git repository has ever been public, consider the old image files exposed even after removing them from the current version.

## Notes and limitations

- The project uses one shared account, so every family member has the same permissions. Keep sign-ups disabled.
- Trip edits are synced through one shared JSON document. Avoid editing simultaneously on multiple devices; the most recent save replaces the shared document.
- Photos are stored as private WebP display copies, not originals. Keep the originals in Google Photos or another archive.
- Trip and country thumbnails are picked from their available photos; trip thumbnails fall back to a photo from the trip's country when the trip has none. Open a photo full-size and choose “Set as [country] default photo” to make it the country thumbnail instead of a random choice.
- Signed image links expire and are refreshed while the page remains open. Reload the page if an image link expires after a long inactive period.
- Review Supabase's current Free-plan database, file-storage, and monthly egress quotas as the album grows.
