/* Server address baked into packaged (Android) builds, so the app only ever
   asks for a name and a passcode. Set it to '' to have the app ask instead.
   If this address ever stops answering, the field reappears on its own.

   Local server on the Wi-Fi:  http://192.168.1.18:3000
   Deployed on Render:         https://blue-hearts.onrender.com  */
window.BLUE_HEARTS_SERVER = 'http://192.168.1.18:3000';
