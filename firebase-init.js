/**
 * Firebase 초기화 (현장 목록 등 실시간 동기화)
 * - compat 스크립트(firebase-app-compat, firebase-firestore-compat) 로드 후 실행
 * - config.js 의 MWMAP_CONFIG.FIREBASE 사용
 * - 완료 시 firebaseReady 이벤트 발생 (window.db, window.firestore 사용 가능)
 */
(function () {
  'use strict';
  if (typeof firebase === 'undefined') {
    console.warn('Firebase compat 스크립트가 로드되지 않았습니다.');
    window.dispatchEvent(new CustomEvent('firebaseReady'));
    return;
  }
  var C = window.MWMAP_CONFIG && window.MWMAP_CONFIG.FIREBASE;
  if (!C) {
    window.dispatchEvent(new CustomEvent('firebaseReady'));
    return;
  }
  try {
    firebase.initializeApp(C);
    var db = firebase.firestore();
    window.db = db;
    window.firestore = {
      doc: function (database, collectionPath, docId) {
        return database.collection(collectionPath).doc(docId);
      },
      getDoc: function (ref) {
        return ref.get();
      },
      setDoc: function (ref, data) {
        return ref.set(data);
      },
      updateDoc: function (ref, data) {
        return ref.update(data);
      },
      arrayUnion: function () {
        return firebase.firestore.FieldValue.arrayUnion.apply(
          firebase.firestore.FieldValue,
          arguments
        );
      },
      onSnapshot: function (ref, onNext, onError) {
        return ref.onSnapshot(onNext, onError);
      },
      serverTimestamp: function () {
        return firebase.firestore.FieldValue.serverTimestamp();
      }
    };
  } catch (e) {
    console.warn('Firebase 초기화 실패:', e);
  }
  window.dispatchEvent(new CustomEvent('firebaseReady'));
})();
