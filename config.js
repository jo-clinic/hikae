// ===== 設置時にここだけ書き換える =====
window.APP_CONFIG = {
  GOOGLE_CLIENT_ID: "743430255744-h5ssub26qu3i1q75d4n42k177ukmeu13.apps.googleusercontent.com",
  PROXY_URL: "http://localhost:8080",        // Cloud Run へ載せたら https://xxxx.run.app
  DRIVE_FOLDER_NAME: "Hikae",
  LICENSE_GRACE_DAYS: 14                     // オフライン時に前回検証から何日まで使えるか
};
