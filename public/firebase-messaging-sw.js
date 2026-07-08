importScripts('https://www.gstatic.com/firebasejs/10.5.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.5.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyALW8fYOLzo_T4JfBp5N25FK9thHy3aulA',
  projectId: 'fliptrader-32bc8',
  appId: '1:793909762510:web:1c37756b58461b54a7f39f',
  messagingSenderId: '793909762510',
});

firebase.messaging();
