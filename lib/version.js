/*
 * version.js — アプリのバージョン
 *
 * ★ バージョン番号の定義はここ 1 箇所だけ。上げるときはこの APP_VERSION を書き換える。
 *   画面には class="app-version" の要素へ流し込む (Master と Viewer のヘッダ)。
 *   HTML 側に数字を直書きしないのは、2 箇所に書くと必ずどちらかが古くなるため。
 *
 * 付け方: MAJOR.MINOR.PATCH
 *   MINOR … 機能の追加・仕様の変更
 *   PATCH … 不具合の修正のみ
 *
 *   1.4.0  バージョン表示を追加
 *   1.3.0  ファイル名に _ が無いと 1 ファイル = 1 データセットになる問題を修正。
 *          グループ分けの切り替え / データセット名の編集 / 登録済みデータの統合を追加
 *   1.2.0  登録データをフォルダで整理できるようにした (無制限の階層)
 *   1.1.0  同梱データセットを撤去し、登録したデータ専用にした
 *   1.0.0  imzML/HE の登録・重ね合わせ・レイヤの checkbox 表示・ZIP の往復
 */
(function (global) {
  'use strict';

  const APP_VERSION = '1.4.0';

  global.APP_VERSION = APP_VERSION;

  /** ヘッダなどの .app-version に "v1.4.0" を入れる。 */
  function paint() {
    const nodes = document.querySelectorAll('.app-version');
    for (let i = 0; i < nodes.length; i++) nodes[i].textContent = 'v' + APP_VERSION;
  }

  // このスクリプトが body の末尾にある画面 (Master) と head にある画面 (Viewer) の
  // 両方で動くよう、読み込み済みかどうかで分岐する。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paint);
  } else {
    paint();
  }

  global.AppVersion = { version: APP_VERSION, paint: paint };
})(window);
