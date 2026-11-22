# X Downloader

A userscript that adds a download button to posts on X (x.com) and saves every photo and video of the post in the best quality X has.

- **One button per post:** it sits in the post's action bar, right after Share, on every post with photos, videos or GIFs (in the timeline, on profiles, in search and on a post's own page). A post that quotes another and has no media of its own saves the quoted post's.
- **Quality:** photos are saved at their original size (`name=orig`), videos and GIFs as the MP4 with the highest bitrate.
- **Download history:** a post's button turns blue once it has been downloaded. Downloads are remembered in Tampermonkey's storage.
- **List of downloads:** choose **Downloads** in Tampermonkey's menu to see everything you downloaded, newest first. Each line has a small picture, the account, the text, what was saved, the time and a link, and the list can be searched. Forgetting a line makes its button plain again; the files stay where they are.

Files are named `username (Display Name) - text - id`, with ` - 1`, ` - 2` … when a post has several photos or videos.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open `x-downloader.user.js` in this repository, click **Raw**, and let Tampermonkey install it.
3. Reload x.com. The first download may ask to allow downloading several files from x.com.

## Note

For personal archiving of content you have the right to keep. Re-uploading other people's content may break X's terms and copyright law. This project is not affiliated with X Corp.
