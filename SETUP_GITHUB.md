# 設置手順（GitHub Pages ＋ Google Drive）

所要時間 20〜30分。一度やれば以降のアプリでも同じ手順です。

## 1. GitHubに置く
1. GitHubで新しいリポジトリを作成（例: `hikae`、Public）
2. このフォルダの全ファイル（index.html, app.js, config.js, sw.js, manifest.json, 画像ファイル4つ）をアップロード
3. Settings → Pages → Branch を `main` / `(root)` にして Save
4. 数分後に `https://<ユーザー名>.github.io/hikae/` で開ける

## 2. Google Cloud で OAuth クライアントIDを作る（Drive接続用）
1. https://console.cloud.google.com → プロジェクトを新規作成（例: hikae）
2. 「APIとサービス」→「ライブラリ」→ **Google Drive API** を検索して「有効にする」
3. 「APIとサービス」→「OAuth同意画面」→ 外部 → アプリ名・メールを入力 → スコープは追加不要 → テストユーザーに社長のGmailを追加
4. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」→ 種類「ウェブアプリケーション」
5. **承認済みのJavaScript生成元** に `https://<ユーザー名>.github.io` を追加
6. **承認済みのリダイレクトURI** に `https://<ユーザー名>.github.io/hikae/` を追加（末尾の / まで正確に）
7. 作成 → 表示される「クライアントID」（xxxx.apps.googleusercontent.com）をコピー

## 3. config.js を書き換える
```
GOOGLE_CLIENT_ID: "コピーしたクライアントID",
PROXY_URL: "https://<Cloud RunのURL>",   // ローカルテスト中は http://localhost:8080
```
GitHub上で config.js を編集してコミットすれば反映されます。

## 4. iPhoneでの初期設定（社長にやってもらうこと）
1. Safariで上記URLを開く → 共有ボタン → 「ホーム画面に追加」（必須。Safariのままだとデータが消えることがある）
2. ホーム画面のアイコンから起動 → 合言葉とライセンスキーを入力
3. 表示されたリカバリーコードを保管
4. 設定 → Driveに接続 → Googleアカウントで許可
5. 設定 → カードを追加

## 動作確認のポイント
- ホームの状態表示が「クラウド」「ライセンス trial」「Drive接続中」の3つとも緑になること
- 「控えを撮る」→ 撮影 → 数秒で確認画面に読み取り結果が入ること
- 設定 → 今すぐ同期 → Google Driveに「Hikae」フォルダができること

## ローカルでの動作確認（PC）
`python -m http.server 8000` をこのフォルダで実行し、http://localhost:8000 を開く。
Drive接続を試すときはリダイレクトURIに `http://localhost:8000/` も追加しておく。

## 既知の制約
- Driveの接続は1時間で切れる。切れたら「もう一度接続」を押すだけ（数秒）
- 画像はDrive上では平文（PCで見られる）。DBファイル db.json.enc は合言葉がないと開けない
- 機種変更: 新端末で先に「Driveに接続して復元する」→ 合言葉 → 自動復元
