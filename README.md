# MAILSHEET Private Beta

Gmailに届く定型メールから必要な項目を抽出し、Google Sheetsへ書き込むWebサービスです。

## 主な画面

- LP：サービス概要、3ステップ、活用例、セキュリティ設計、料金、FAQ
- `/app`：Dashboard、Connections、Rule Editor、History、Settings
- Rule Editor：実メール選択、自然な日本語の抽出方法、リアルタイムプレビュー、列マッピング、テスト書込、手動同期
- D1：利用者ごとのGoogle接続、抽出ルール、重複処理防止、処理履歴

## Google OAuthの有効化

Google CloudでOAuth 2.0のウェブクライアントを作成し、公開URLの
`/api/oauth/google/callback` を承認済みリダイレクトURIへ登録します。次の値はリポジトリへ保存せず、Siteの暗号化された環境変数として設定します。

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `TOKEN_ENCRYPTION_KEY`（十分に長いランダム値）

利用するGoogle権限はGmail読取専用とGoogle Sheetsです。公開提供前にGoogleのOAuth審査要件を確認してください。

## 検証

```bash
npm run typecheck
npm run lint
npm test
```
