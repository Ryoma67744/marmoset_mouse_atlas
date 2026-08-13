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
 *   1.6.0  TIC を登録・表示しないようにした。透明度を同じ種類のレイヤ全体に効かせた。
 *          MSI の着色をカラーマップから分子ごとの固定色に戻した (線形・補間なしは維持)
 *   1.5.0  レイヤの checkbox を横並びにし、強度レンジ / 透明度を常時表示。
 *          MSI の表示を Share_Test と同じ方式に (1 分子ならカラーマップ、複数なら
 *          分子色の加算合成 / 線形 / 補間なし)。HE のモノクロ表示を追加
 *   1.4.0  バージョン表示を追加
 *   1.3.0  ファイル名に _ が無いと 1 ファイル = 1 データセットになる問題を修正。
 *          グループ分けの切り替え / データセット名の編集 / 登録済みデータの統合を追加
 *   1.2.0  登録データをフォルダで整理できるようにした (無制限の階層)
 *   1.1.0  同梱データセットを撤去し、登録したデータ専用にした
 *   1.0.0  imzML/HE の登録・重ね合わせ・レイヤの checkbox 表示・ZIP の往復
 */
(function (global) {
  'use strict';

  const APP_VERSION = '1.6.0';

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
