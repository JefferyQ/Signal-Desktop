/* global
  $,
  _,
  Backbone,
  ConversationController,
  MessageController,
  getAccountManager,
  Signal,
  storage,
  textsecure,
  WebAPI
  Whisper,
*/

// eslint-disable-next-line func-names
(async function() {
  'use strict';

  const eventHandlerQueue = new window.PQueue({ concurrency: 1 });

  // Globally disable drag and drop
  document.body.addEventListener(
    'dragover',
    e => {
      e.preventDefault();
      e.stopPropagation();
    },
    false
  );
  document.body.addEventListener(
    'drop',
    e => {
      e.preventDefault();
      e.stopPropagation();
    },
    false
  );

  // Load these images now to ensure that they don't flicker on first use
  window.Signal.EmojiLib.preloadImages();
  const images = [];
  function preload(list) {
    for (let index = 0, max = list.length; index < max; index += 1) {
      const image = new Image();
      image.src = `./images/${list[index]}`;
      images.push(image);
    }
  }
  preload([
    'alert-outline.svg',
    'android.svg',
    'apple.svg',
    'appstore.svg',
    'audio.svg',
    'back.svg',
    'chat-bubble-outline.svg',
    'chat-bubble.svg',
    'check-circle-outline.svg',
    'check.svg',
    'clock.svg',
    'close-circle.svg',
    'delete.svg',
    'dots-horizontal.svg',
    'double-check.svg',
    'down.svg',
    'download.svg',
    'ellipsis.svg',
    'error.svg',
    'error_red.svg',
    'file-gradient.svg',
    'file.svg',
    'folder-outline.svg',
    'forward.svg',
    'gear.svg',
    'group_default.png',
    'hourglass_empty.svg',
    'hourglass_full.svg',
    'icon_1024.png',
    'icon_128.png',
    'icon_16.png',
    'icon_250.png',
    'icon_256.png',
    'icon_32.png',
    'icon_48.png',
    'image.svg',
    'import.svg',
    'lead-pencil.svg',
    'menu.svg',
    'microphone.svg',
    'movie.svg',
    'open_link.svg',
    'paperclip.svg',
    'play.svg',
    'playstore.png',
    'read.svg',
    'reply.svg',
    'save.svg',
    'search.svg',
    'sending.svg',
    'shield.svg',
    'signal-laptop.png',
    'signal-phone.png',
    'smile.svg',
    'sync.svg',
    'timer-00.svg',
    'timer-05.svg',
    'timer-10.svg',
    'timer-15.svg',
    'timer-20.svg',
    'timer-25.svg',
    'timer-30.svg',
    'timer-35.svg',
    'timer-40.svg',
    'timer-45.svg',
    'timer-50.svg',
    'timer-55.svg',
    'timer-60.svg',
    'timer.svg',
    'verified-check.svg',
    'video.svg',
    'voice.svg',
    'warning.svg',
    'x.svg',
    'x_white.svg',
  ]);

  // We add this to window here because the default Node context is erased at the end
  //   of preload.js processing
  window.setImmediate = window.nodeSetImmediate;

  const { IdleDetector, MessageDataMigrator } = Signal.Workflow;
  const {
    mandatoryMessageUpgrade,
    migrateAllToSQLCipher,
    removeDatabase,
    runMigrations,
    doesDatabaseExist,
  } = Signal.IndexedDB;
  const { Errors, Message } = window.Signal.Types;
  const {
    upgradeMessageSchema,
    writeNewAttachmentData,
    deleteAttachmentData,
  } = window.Signal.Migrations;
  const { Views } = window.Signal;

  // Implicitly used in `indexeddb-backbonejs-adapter`:
  // https://github.com/signalapp/Signal-Desktop/blob/4033a9f8137e62ed286170ed5d4941982b1d3a64/components/indexeddb-backbonejs-adapter/backbone-indexeddb.js#L569
  window.onInvalidStateError = error =>
    window.log.error(error && error.stack ? error.stack : error);

  window.log.info('background page reloaded');
  window.log.info('environment:', window.getEnvironment());

  let idleDetector;
  let initialLoadComplete = false;
  let newVersion = false;

  window.owsDesktopApp = {};
  window.document.title = window.getTitle();

  // start a background worker for ecc
  textsecure.startWorker('js/libsignal-protocol-worker.js');
  Whisper.KeyChangeListener.init(textsecure.storage.protocol);
  textsecure.storage.protocol.on('removePreKey', () => {
    getAccountManager().refreshPreKeys();
  });

  let messageReceiver;
  window.getSocketStatus = () => {
    if (messageReceiver) {
      return messageReceiver.getStatus();
    }
    return -1;
  };
  Whisper.events = _.clone(Backbone.Events);
  let accountManager;
  window.getAccountManager = () => {
    if (!accountManager) {
      const USERNAME = storage.get('number_id');
      const PASSWORD = storage.get('password');
      accountManager = new textsecure.AccountManager(USERNAME, PASSWORD);
      accountManager.addEventListener('registration', () => {
        const user = {
          regionCode: window.storage.get('regionCode'),
          ourNumber: textsecure.storage.user.getNumber(),
        };
        Whisper.events.trigger('userChanged', user);

        Whisper.Registration.markDone();
        window.log.info('dispatching registration event');
        Whisper.events.trigger('registration_done');
      });
    }
    return accountManager;
  };

  const cancelInitializationMessage = Views.Initialization.setMessage();

  const isIndexedDBPresent = await doesDatabaseExist();
  if (isIndexedDBPresent) {
    window.installStorage(window.legacyStorage);
    window.log.info('Start IndexedDB migrations');
    await runMigrations();
  }

  window.log.info('Storage fetch');
  storage.fetch();

  function mapOldThemeToNew(theme) {
    switch (theme) {
      case 'dark':
      case 'light':
      case 'system':
        return theme;
      case 'android-dark':
        return 'dark';
      case 'android':
      case 'ios':
      default:
        return 'light';
    }
  }

  // We need this 'first' check because we don't want to start the app up any other time
  //   than the first time. And storage.fetch() will cause onready() to fire.
  let first = true;
  storage.onready(async () => {
    if (!first) {
      return;
    }
    first = false;

    // These make key operations available to IPC handlers created in preload.js
    window.Events = {
      getDeviceName: () => textsecure.storage.user.getDeviceName(),

      getThemeSetting: () =>
        storage.get(
          'theme-setting',
          window.platform === 'darwin' ? 'system' : 'light'
        ),
      setThemeSetting: value => {
        storage.put('theme-setting', value);
        onChangeTheme();
      },
      getHideMenuBar: () => storage.get('hide-menu-bar'),
      setHideMenuBar: value => {
        storage.put('hide-menu-bar', value);
        window.setAutoHideMenuBar(value);
        window.setMenuBarVisibility(!value);
      },

      getNotificationSetting: () =>
        storage.get('notification-setting', 'message'),
      setNotificationSetting: value =>
        storage.put('notification-setting', value),
      getAudioNotification: () => storage.get('audio-notification'),
      setAudioNotification: value => storage.put('audio-notification', value),

      getSpellCheck: () => storage.get('spell-check', true),
      setSpellCheck: value => {
        storage.put('spell-check', value);
        startSpellCheck();
      },

      // eslint-disable-next-line eqeqeq
      isPrimary: () => textsecure.storage.user.getDeviceId() == '1',
      getSyncRequest: () =>
        new Promise((resolve, reject) => {
          const syncRequest = window.getSyncRequest();
          syncRequest.addEventListener('success', resolve);
          syncRequest.addEventListener('timeout', reject);
        }),
      getLastSyncTime: () => storage.get('synced_at'),
      setLastSyncTime: value => storage.put('synced_at', value),

      addDarkOverlay: () => {
        if ($('.dark-overlay').length) {
          return;
        }
        $(document.body).prepend('<div class="dark-overlay"></div>');
        $('.dark-overlay').on('click', () => $('.dark-overlay').remove());
      },
      removeDarkOverlay: () => $('.dark-overlay').remove(),
      deleteAllData: () => {
        const clearDataView = new window.Whisper.ClearDataView().render();
        $('body').append(clearDataView.el);
      },

      shutdown: async () => {
        // Stop background processing
        window.Signal.AttachmentDownloads.stop();
        if (idleDetector) {
          idleDetector.stop();
        }

        // Stop processing incoming messages
        if (messageReceiver) {
          await messageReceiver.stopProcessing();
          messageReceiver = null;
        }

        // Shut down the data interface cleanly
        await window.Signal.Data.shutdown();
      },

      showStickerPack: async (packId, key) => {
        // Kick off the download
        window.Signal.Stickers.downloadEphemeralPack(packId, key);

        const props = {
          packId,
          onClose: async () => {
            stickerPreviewModalView.remove();
            await window.Signal.Stickers.removeEphemeralPack(packId);
          },
        };

        const stickerPreviewModalView = new Whisper.ReactWrapperView({
          className: 'sticker-preview-modal-wrapper',
          JSX: Signal.State.Roots.createStickerPreviewModal(
            window.reduxStore,
            props
          ),
        });
      },
    };

    const currentVersion = window.getVersion();
    const lastVersion = storage.get('version');
    newVersion = !lastVersion || currentVersion !== lastVersion;
    await storage.put('version', currentVersion);

    if (newVersion && lastVersion) {
      window.log.info(
        `New version detected: ${currentVersion}; previous: ${lastVersion}`
      );

      const themeSetting = window.Events.getThemeSetting();
      const newThemeSetting = mapOldThemeToNew(themeSetting);

      if (
        window.isBeforeVersion(lastVersion, 'v1.25.0') &&
        window.platform === 'darwin' &&
        newThemeSetting === window.systemTheme
      ) {
        window.Events.setThemeSetting('system');
      } else {
        window.Events.setThemeSetting(newThemeSetting);
      }

      if (window.isBeforeVersion(lastVersion, 'v1.25.0')) {
        // Stickers flags
        await Promise.all([
          storage.put('showStickersIntroduction', true),
          storage.put('showStickerPickerHint', true),
        ]);
      }

      // This one should always be last - it could restart the app
      if (window.isBeforeVersion(lastVersion, 'v1.15.0-beta.5')) {
        await window.Signal.Logs.deleteAll();
        window.restart();
      }
    }

    if (isIndexedDBPresent) {
      await mandatoryMessageUpgrade({ upgradeMessageSchema });
      await migrateAllToSQLCipher({ writeNewAttachmentData, Views });
      await removeDatabase();
      try {
        await window.Signal.Data.removeIndexedDBFiles();
      } catch (error) {
        window.log.error(
          'Failed to remove IndexedDB files:',
          error && error.stack ? error.stack : error
        );
      }

      window.installStorage(window.newStorage);
      await window.storage.fetch();
      await storage.put('indexeddb-delete-needed', true);
    }

    Views.Initialization.setMessage(window.i18n('optimizingApplication'));

    if (newVersion) {
      await window.Signal.Data.cleanupOrphanedAttachments();
    }

    Views.Initialization.setMessage(window.i18n('loading'));

    idleDetector = new IdleDetector();
    let isMigrationWithIndexComplete = false;
    window.log.info(
      `Starting background data migration. Target version: ${
        Message.CURRENT_SCHEMA_VERSION
      }`
    );
    idleDetector.on('idle', async () => {
      const NUM_MESSAGES_PER_BATCH = 1;

      if (!isMigrationWithIndexComplete) {
        const batchWithIndex = await MessageDataMigrator.processNext({
          BackboneMessage: Whisper.Message,
          BackboneMessageCollection: Whisper.MessageCollection,
          numMessagesPerBatch: NUM_MESSAGES_PER_BATCH,
          upgradeMessageSchema,
          getMessagesNeedingUpgrade:
            window.Signal.Data.getMessagesNeedingUpgrade,
          saveMessage: window.Signal.Data.saveMessage,
        });
        window.log.info('Upgrade message schema (with index):', batchWithIndex);
        isMigrationWithIndexComplete = batchWithIndex.done;
      }

      if (isMigrationWithIndexComplete) {
        window.log.info(
          'Background migration complete. Stopping idle detector.'
        );
        idleDetector.stop();
      }
    });

    const startSpellCheck = () => {
      if (!window.enableSpellCheck || !window.disableSpellCheck) {
        return;
      }

      if (window.Events.getSpellCheck()) {
        window.enableSpellCheck();
      } else {
        window.disableSpellCheck();
      }
    };
    startSpellCheck();

    try {
      await Promise.all([
        ConversationController.load(),
        Signal.Stickers.load(),
        Signal.Emojis.load(),
        textsecure.storage.protocol.hydrateCaches(),
      ]);
    } catch (error) {
      window.log.error(
        'background.js: ConversationController failed to load:',
        error && error.stack ? error.stack : error
      );
    } finally {
      initializeRedux();
      start();
    }
  });

  function initializeRedux() {
    // Here we set up a full redux store with initial state for our LeftPane Root
    const convoCollection = window.getConversations();
    const conversations = convoCollection.map(
      conversation => conversation.cachedProps
    );
    const initialState = {
      conversations: {
        conversationLookup: Signal.Util.makeLookup(conversations, 'id'),
      },
      emojis: Signal.Emojis.getInitialState(),
      items: storage.getItemsState(),
      stickers: Signal.Stickers.getInitialState(),
      user: {
        attachmentsPath: window.baseAttachmentsPath,
        stickersPath: window.baseStickersPath,
        tempPath: window.baseTempPath,
        regionCode: window.storage.get('regionCode'),
        ourNumber: textsecure.storage.user.getNumber(),
        i18n: window.i18n,
      },
    };

    const store = Signal.State.createStore(initialState);
    window.reduxStore = store;

    const actions = {};
    window.reduxActions = actions;

    // Binding these actions to our redux store and exposing them allows us to update
    //   redux when things change in the backbone world.
    actions.conversations = Signal.State.bindActionCreators(
      Signal.State.Ducks.conversations.actions,
      store.dispatch
    );
    actions.emojis = Signal.State.bindActionCreators(
      Signal.State.Ducks.emojis.actions,
      store.dispatch
    );
    actions.items = Signal.State.bindActionCreators(
      Signal.State.Ducks.items.actions,
      store.dispatch
    );
    actions.user = Signal.State.bindActionCreators(
      Signal.State.Ducks.user.actions,
      store.dispatch
    );
    actions.stickers = Signal.State.bindActionCreators(
      Signal.State.Ducks.stickers.actions,
      store.dispatch
    );

    const {
      conversationAdded,
      conversationChanged,
      conversationRemoved,
      removeAllConversations,
      messageExpired,
    } = actions.conversations;
    const { userChanged } = actions.user;

    convoCollection.on('remove', conversation => {
      const { id } = conversation || {};
      conversationRemoved(id);
    });
    convoCollection.on('add', conversation => {
      const { id, cachedProps } = conversation || {};
      conversationAdded(id, cachedProps);
    });
    convoCollection.on('change', conversation => {
      const { id, cachedProps } = conversation || {};
      conversationChanged(id, cachedProps);
    });
    convoCollection.on('reset', removeAllConversations);

    Whisper.events.on('messageExpired', messageExpired);
    Whisper.events.on('userChanged', userChanged);

    // In the future this listener will be added by the conversation view itself. But
    //   because we currently have multiple converations open at once, we install just
    //   one global handler.
    // $(document).on('keydown', event => {
    //   const { ctrlKey, key } = event;

    // We can add Command-E as the Mac shortcut when we add it to our Electron menus:
    //   https://stackoverflow.com/questions/27380018/when-cmd-key-is-kept-pressed-keyup-is-not-triggered-for-any-other-key
    // For now, it will stay as CTRL-E only
    //   if (key === 'e' && ctrlKey) {
    //     const state = store.getState();
    //     const selectedId = state.conversations.selectedConversation;
    //     const conversation = ConversationController.get(selectedId);

    //     if (conversation && !conversation.get('isArchived')) {
    //       conversation.setArchived(true);
    //       conversation.trigger('unload');
    //     }
    //   }
    // });
  }

  Whisper.events.on('setupWithImport', () => {
    const { appView } = window.owsDesktopApp;
    if (appView) {
      appView.openImporter();
    }
  });

  Whisper.events.on('setupAsNewDevice', () => {
    const { appView } = window.owsDesktopApp;
    if (appView) {
      appView.openInstaller();
    }
  });

  Whisper.events.on('setupAsStandalone', () => {
    const { appView } = window.owsDesktopApp;
    if (appView) {
      appView.openStandalone();
    }
  });

  async function start() {
    window.dispatchEvent(new Event('storage_ready'));

    window.log.info('Cleanup: starting...');
    const messagesForCleanup = await window.Signal.Data.getOutgoingWithoutExpiresAt(
      {
        MessageCollection: Whisper.MessageCollection,
      }
    );
    window.log.info(
      `Cleanup: Found ${messagesForCleanup.length} messages for cleanup`
    );
    await Promise.all(
      messagesForCleanup.map(async message => {
        const delivered = message.get('delivered');
        const sentAt = message.get('sent_at');
        const expirationStartTimestamp = message.get(
          'expirationStartTimestamp'
        );

        if (message.hasErrors()) {
          return;
        }

        if (delivered) {
          window.log.info(
            `Cleanup: Starting timer for delivered message ${sentAt}`
          );
          message.set(
            'expirationStartTimestamp',
            expirationStartTimestamp || sentAt
          );
          await message.setToExpire();
          return;
        }

        window.log.info(`Cleanup: Deleting unsent message ${sentAt}`);
        await window.Signal.Data.removeMessage(message.id, {
          Message: Whisper.Message,
        });
        const conversation = message.getConversation();
        if (conversation) {
          await conversation.updateLastMessage();
        }
      })
    );
    window.log.info('Cleanup: complete');

    window.log.info('listening for registration events');
    Whisper.events.on('registration_done', () => {
      window.log.info('handling registration event');

      // listeners
      Whisper.RotateSignedPreKeyListener.init(Whisper.events, newVersion);
      window.Signal.RefreshSenderCertificate.initialize({
        events: Whisper.events,
        storage,
        navigator,
        logger: window.log,
      });

      connect(true);
    });

    cancelInitializationMessage();
    const appView = new Whisper.AppView({
      el: $('body'),
    });
    window.owsDesktopApp.appView = appView;

    Whisper.WallClockListener.init(Whisper.events);
    Whisper.ExpiringMessagesListener.init(Whisper.events);

    if (Whisper.Import.isIncomplete()) {
      window.log.info('Import was interrupted, showing import error screen');
      appView.openImporter();
    } else if (Whisper.Registration.everDone()) {
      // listeners
      Whisper.RotateSignedPreKeyListener.init(Whisper.events, newVersion);
      window.Signal.RefreshSenderCertificate.initialize({
        events: Whisper.events,
        storage,
        navigator,
        logger: window.log,
      });

      connect();
      appView.openInbox({
        initialLoadComplete,
      });
    } else if (window.isImportMode()) {
      appView.openImporter();
    } else {
      appView.openInstaller();
    }

    Whisper.events.on('showDebugLog', () => {
      appView.openDebugLog();
    });
    Whisper.events.on('unauthorized', () => {
      appView.inboxView.networkStatusView.update();
    });
    Whisper.events.on('reconnectTimer', () => {
      appView.inboxView.networkStatusView.setSocketReconnectInterval(60000);
    });
    Whisper.events.on('contactsync', () => {
      if (appView.installView) {
        appView.openInbox();
      }
    });

    window.addEventListener('focus', () => Whisper.Notifications.clear());
    window.addEventListener('unload', () => Whisper.Notifications.fastClear());

    Whisper.events.on('showConversation', (id, messageId) => {
      if (appView) {
        appView.openConversation(id, messageId);
      }
    });

    Whisper.Notifications.on('click', (id, messageId) => {
      window.showWindow();
      if (id) {
        appView.openConversation(id, messageId);
      } else {
        appView.openInbox({
          initialLoadComplete,
        });
      }
    });
  }

  window.getSyncRequest = () =>
    new textsecure.SyncRequest(textsecure.messaging, messageReceiver);

  let disconnectTimer = null;
  function onOffline() {
    window.log.info('offline');

    window.removeEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    // We've received logs from Linux where we get an 'offline' event, then 30ms later
    //   we get an online event. This waits a bit after getting an 'offline' event
    //   before disconnecting the socket manually.
    disconnectTimer = setTimeout(disconnect, 1000);
  }

  function onOnline() {
    window.log.info('online');

    window.removeEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    if (disconnectTimer && isSocketOnline()) {
      window.log.warn('Already online. Had a blip in online/offline status.');
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
      return;
    }
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }

    connect();
  }

  function isSocketOnline() {
    const socketStatus = window.getSocketStatus();
    return (
      socketStatus === WebSocket.CONNECTING || socketStatus === WebSocket.OPEN
    );
  }

  function disconnect() {
    window.log.info('disconnect');

    // Clear timer, since we're only called when the timer is expired
    disconnectTimer = null;

    if (messageReceiver) {
      messageReceiver.close();
    }
    window.Signal.AttachmentDownloads.stop();
  }

  let connectCount = 0;
  async function connect(firstRun) {
    window.log.info('connect');

    // Bootstrap our online/offline detection, only the first time we connect
    if (connectCount === 0 && navigator.onLine) {
      window.addEventListener('offline', onOffline);
    }
    if (connectCount === 0 && !navigator.onLine) {
      window.log.warn(
        'Starting up offline; will connect when we have network access'
      );
      window.addEventListener('online', onOnline);
      onEmpty(); // this ensures that the loading screen is dismissed
      return;
    }

    if (!Whisper.Registration.everDone()) {
      return;
    }
    if (Whisper.Import.isIncomplete()) {
      return;
    }

    if (messageReceiver) {
      messageReceiver.close();
    }

    const USERNAME = storage.get('number_id');
    const PASSWORD = storage.get('password');
    const mySignalingKey = storage.get('signaling_key');

    connectCount += 1;
    const options = {
      retryCached: connectCount === 1,
      serverTrustRoot: window.getServerTrustRoot(),
    };

    Whisper.Notifications.disable(); // avoid notification flood until empty

    // initialize the socket and start listening for messages
    messageReceiver = new textsecure.MessageReceiver(
      USERNAME,
      PASSWORD,
      mySignalingKey,
      options
    );

    function addQueuedEventListener(name, handler) {
      messageReceiver.addEventListener(name, (...args) =>
        eventHandlerQueue.add(() => handler(...args))
      );
    }

    addQueuedEventListener('message', onMessageReceived);
    addQueuedEventListener('delivery', onDeliveryReceipt);
    addQueuedEventListener('contact', onContactReceived);
    addQueuedEventListener('group', onGroupReceived);
    addQueuedEventListener('sent', onSentMessage);
    addQueuedEventListener('readSync', onReadSync);
    addQueuedEventListener('read', onReadReceipt);
    addQueuedEventListener('verified', onVerified);
    addQueuedEventListener('error', onError);
    addQueuedEventListener('empty', onEmpty);
    addQueuedEventListener('reconnect', onReconnect);
    addQueuedEventListener('progress', onProgress);
    addQueuedEventListener('configuration', onConfiguration);
    addQueuedEventListener('typing', onTyping);
    addQueuedEventListener('sticker-pack', onStickerPack);

    window.Signal.AttachmentDownloads.start({
      getMessageReceiver: () => messageReceiver,
      logger: window.log,
    });

    window.textsecure.messaging = new textsecure.MessageSender(
      USERNAME,
      PASSWORD
    );

    if (connectCount === 1) {
      window.Signal.Stickers.downloadQueuedPacks();
    }

    // On startup after upgrading to a new version, request a contact sync
    //   (but only if we're not the primary device)
    if (
      !firstRun &&
      connectCount === 1 &&
      newVersion &&
      // eslint-disable-next-line eqeqeq
      textsecure.storage.user.getDeviceId() != '1'
    ) {
      window.getSyncRequest();

      try {
        const manager = window.getAccountManager();
        await Promise.all([
          manager.maybeUpdateDeviceName(),
          manager.maybeDeleteSignalingKey(),
        ]);
      } catch (e) {
        window.log.error(
          'Problem with account manager updates after starting new version: ',
          e && e.stack ? e.stack : e
        );
      }
    }

    const udSupportKey = 'hasRegisterSupportForUnauthenticatedDelivery';
    if (!storage.get(udSupportKey)) {
      const server = WebAPI.connect({ username: USERNAME, password: PASSWORD });
      try {
        await server.registerSupportForUnauthenticatedDelivery();
        storage.put(udSupportKey, true);
      } catch (error) {
        window.log.error(
          'Error: Unable to register for unauthenticated delivery support.',
          error && error.stack ? error.stack : error
        );
      }
    }

    const deviceId = textsecure.storage.user.getDeviceId();
    if (firstRun === true && deviceId !== '1') {
      const hasThemeSetting = Boolean(storage.get('theme-setting'));
      if (!hasThemeSetting && textsecure.storage.get('userAgent') === 'OWI') {
        storage.put('theme-setting', 'ios');
        onChangeTheme();
      }
      const syncRequest = new textsecure.SyncRequest(
        textsecure.messaging,
        messageReceiver
      );
      Whisper.events.trigger('contactsync:begin');
      syncRequest.addEventListener('success', () => {
        window.log.info('sync successful');
        storage.put('synced_at', Date.now());
        Whisper.events.trigger('contactsync');
      });
      syncRequest.addEventListener('timeout', () => {
        window.log.error('sync timed out');
        Whisper.events.trigger('contactsync');
      });

      const ourNumber = textsecure.storage.user.getNumber();
      const { wrap, sendOptions } = ConversationController.prepareForSend(
        ourNumber,
        { syncMessage: true }
      );

      const installedStickerPacks = window.Signal.Stickers.getInstalledStickerPacks();
      if (installedStickerPacks.length) {
        const operations = installedStickerPacks.map(pack => ({
          packId: pack.id,
          packKey: pack.key,
          installed: true,
        }));

        wrap(
          window.textsecure.messaging.sendStickerPackSync(
            operations,
            sendOptions
          )
        ).catch(error => {
          window.log.error(
            'Failed to send installed sticker packs via sync message',
            error && error.stack ? error.stack : error
          );
        });
      }

      if (Whisper.Import.isComplete()) {
        wrap(
          textsecure.messaging.sendRequestConfigurationSyncMessage(sendOptions)
        ).catch(error => {
          window.log.error(
            'Import complete, but failed to send sync message',
            error && error.stack ? error.stack : error
          );
        });
      }
    }

    storage.onready(async () => {
      idleDetector.start();
    });
  }

  function onChangeTheme() {
    const view = window.owsDesktopApp.appView;
    if (view) {
      view.applyTheme();
    }
  }
  function onEmpty() {
    initialLoadComplete = true;

    window.readyForUpdates();

    let interval = setInterval(() => {
      const view = window.owsDesktopApp.appView;
      if (view) {
        clearInterval(interval);
        interval = null;
        view.onEmpty();
      }
    }, 500);

    Whisper.Notifications.enable();
  }
  function onReconnect() {
    // We disable notifications on first connect, but the same applies to reconnect. In
    //   scenarios where we're coming back from sleep, we can get offline/online events
    //   very fast, and it looks like a network blip. But we need to suppress
    //   notifications in these scenarios too. So we listen for 'reconnect' events.
    Whisper.Notifications.disable();
  }
  function onProgress(ev) {
    const { count } = ev;
    window.log.info(`onProgress: Message count is ${count}`);

    const view = window.owsDesktopApp.appView;
    if (view) {
      view.onProgress(count);
    }
  }
  function onConfiguration(ev) {
    const { configuration } = ev;
    const {
      readReceipts,
      typingIndicators,
      unidentifiedDeliveryIndicators,
      linkPreviews,
    } = configuration;

    storage.put('read-receipt-setting', readReceipts);

    if (
      unidentifiedDeliveryIndicators === true ||
      unidentifiedDeliveryIndicators === false
    ) {
      storage.put(
        'unidentifiedDeliveryIndicators',
        unidentifiedDeliveryIndicators
      );
    }

    if (typingIndicators === true || typingIndicators === false) {
      storage.put('typingIndicators', typingIndicators);
    }

    if (linkPreviews === true || linkPreviews === false) {
      storage.put('linkPreviews', linkPreviews);
    }

    ev.confirm();
  }

  function onTyping(ev) {
    const { typing, sender, senderDevice } = ev;
    const { groupId, started } = typing || {};

    // We don't do anything with incoming typing messages if the setting is disabled
    if (!storage.get('typingIndicators')) {
      return;
    }

    const conversation = ConversationController.get(groupId || sender);
    const ourNumber = textsecure.storage.user.getNumber();

    if (conversation) {
      // We drop typing notifications in groups we're not a part of
      if (!conversation.isPrivate() && !conversation.hasMember(ourNumber)) {
        window.log.warn(
          `Received typing indicator for group ${conversation.idForLogging()}, which we're not a part of. Dropping.`
        );
        return;
      }

      conversation.notifyTyping({
        isTyping: started,
        sender,
        senderDevice,
      });
    }
  }

  async function onStickerPack(ev) {
    const packs = ev.stickerPacks || [];

    packs.forEach(pack => {
      const { id, key, isInstall, isRemove } = pack || {};

      if (!id || !key || (!isInstall && !isRemove)) {
        window.log.warn(
          'Received malformed sticker pack operation sync message'
        );
        return;
      }

      const status = window.Signal.Stickers.getStickerPackStatus(id);

      if (status === 'installed' && isRemove) {
        window.reduxActions.stickers.uninstallStickerPack(id, key, {
          fromSync: true,
        });
      } else if (isInstall) {
        if (status === 'downloaded') {
          window.reduxActions.stickers.installStickerPack(id, key, {
            fromSync: true,
          });
        } else {
          window.Signal.Stickers.downloadStickerPack(id, key, {
            finalStatus: 'installed',
            fromSync: true,
          });
        }
      }
    });

    ev.confirm();
  }

  async function onContactReceived(ev) {
    const details = ev.contactDetails;

    const id = details.number;

    if (id === textsecure.storage.user.getNumber()) {
      // special case for syncing details about ourselves
      if (details.profileKey) {
        window.log.info('Got sync message with our own profile key');
        storage.put('profileKey', details.profileKey);
      }
    }

    const c = new Whisper.Conversation({
      id,
    });
    const validationError = c.validateNumber();
    if (validationError) {
      window.log.error(
        'Invalid contact received:',
        Errors.toLogFormat(validationError)
      );
      return;
    }

    try {
      const conversation = await ConversationController.getOrCreateAndWait(
        id,
        'private'
      );
      let activeAt = conversation.get('active_at');

      // The idea is to make any new contact show up in the left pane. If
      //   activeAt is null, then this contact has been purposefully hidden.
      if (activeAt !== null) {
        activeAt = activeAt || Date.now();
      }

      if (details.profileKey) {
        const profileKey = window.Signal.Crypto.arrayBufferToBase64(
          details.profileKey
        );
        conversation.setProfileKey(profileKey);
      } else {
        conversation.dropProfileKey();
      }

      if (typeof details.blocked !== 'undefined') {
        if (details.blocked) {
          storage.addBlockedNumber(id);
        } else {
          storage.removeBlockedNumber(id);
        }
      }

      conversation.set({
        name: details.name,
        color: details.color,
        active_at: activeAt,
      });

      // Update the conversation avatar only if new avatar exists and hash differs
      const { avatar } = details;
      if (avatar && avatar.data) {
        const newAttributes = await window.Signal.Types.Conversation.maybeUpdateAvatar(
          conversation.attributes,
          avatar.data,
          {
            writeNewAttachmentData,
            deleteAttachmentData,
          }
        );
        conversation.set(newAttributes);
      }

      await window.Signal.Data.updateConversation(id, conversation.attributes, {
        Conversation: Whisper.Conversation,
      });
      const { expireTimer } = details;
      const isValidExpireTimer = typeof expireTimer === 'number';
      if (isValidExpireTimer) {
        const source = textsecure.storage.user.getNumber();
        const receivedAt = Date.now();

        await conversation.updateExpirationTimer(
          expireTimer,
          source,
          receivedAt,
          { fromSync: true }
        );
      }

      if (details.verified) {
        const { verified } = details;
        const verifiedEvent = new Event('verified');
        verifiedEvent.verified = {
          state: verified.state,
          destination: verified.destination,
          identityKey: verified.identityKey.toArrayBuffer(),
        };
        verifiedEvent.viaContactSync = true;
        await onVerified(verifiedEvent);
      }
    } catch (error) {
      window.log.error('onContactReceived error:', Errors.toLogFormat(error));
    }
  }

  async function onGroupReceived(ev) {
    const details = ev.groupDetails;
    const { id } = details;

    const conversation = await ConversationController.getOrCreateAndWait(
      id,
      'group'
    );

    const updates = {
      name: details.name,
      members: details.members,
      color: details.color,
      type: 'group',
    };

    if (details.active) {
      const activeAt = conversation.get('active_at');

      // The idea is to make any new group show up in the left pane. If
      //   activeAt is null, then this group has been purposefully hidden.
      if (activeAt !== null) {
        updates.active_at = activeAt || Date.now();
      }
      updates.left = false;
    } else {
      updates.left = true;
    }

    if (details.blocked) {
      storage.addBlockedGroup(id);
    } else {
      storage.removeBlockedGroup(id);
    }

    conversation.set(updates);

    // Update the conversation avatar only if new avatar exists and hash differs
    const { avatar } = details;
    if (avatar && avatar.data) {
      const newAttributes = await window.Signal.Types.Conversation.maybeUpdateAvatar(
        conversation.attributes,
        avatar.data,
        {
          writeNewAttachmentData,
          deleteAttachmentData,
        }
      );
      conversation.set(newAttributes);
    }

    await window.Signal.Data.updateConversation(id, conversation.attributes, {
      Conversation: Whisper.Conversation,
    });
    const { expireTimer } = details;
    const isValidExpireTimer = typeof expireTimer === 'number';
    if (!isValidExpireTimer) {
      return;
    }

    const source = textsecure.storage.user.getNumber();
    const receivedAt = Date.now();
    await conversation.updateExpirationTimer(expireTimer, source, receivedAt, {
      fromSync: true,
    });

    ev.confirm();
  }

  // Descriptors
  const getGroupDescriptor = group => ({
    type: Message.GROUP,
    id: group.id,
  });

  // Matches event data from `libtextsecure` `MessageReceiver::handleSentMessage`:
  const getDescriptorForSent = ({ message, destination }) =>
    message.group
      ? getGroupDescriptor(message.group)
      : { type: Message.PRIVATE, id: destination };

  // Matches event data from `libtextsecure` `MessageReceiver::handleDataMessage`:
  const getDescriptorForReceived = ({ message, source }) =>
    message.group
      ? getGroupDescriptor(message.group)
      : { type: Message.PRIVATE, id: source };

  // Received:
  async function handleMessageReceivedProfileUpdate({
    data,
    confirm,
    messageDescriptor,
  }) {
    const profileKey = data.message.profileKey.toString('base64');
    const sender = await ConversationController.getOrCreateAndWait(
      messageDescriptor.id,
      'private'
    );

    // Will do the save for us
    await sender.setProfileKey(profileKey);

    return confirm();
  }

  async function onMessageReceived(event) {
    const { data, confirm } = event;

    const messageDescriptor = getDescriptorForReceived(data);

    const { PROFILE_KEY_UPDATE } = textsecure.protobuf.DataMessage.Flags;
    // eslint-disable-next-line no-bitwise
    const isProfileUpdate = Boolean(data.message.flags & PROFILE_KEY_UPDATE);
    if (isProfileUpdate) {
      return handleMessageReceivedProfileUpdate({
        data,
        confirm,
        messageDescriptor,
      });
    }

    const message = await initIncomingMessage(data);
    const isDuplicate = await isMessageDuplicate(message);
    if (isDuplicate) {
      window.log.warn('Received duplicate message', message.idForLogging());
      return event.confirm();
    }

    const ourNumber = textsecure.storage.user.getNumber();
    const isGroupUpdate =
      data.message.group &&
      data.message.group.type !== textsecure.protobuf.GroupContext.Type.DELIVER;
    const conversation = ConversationController.get(messageDescriptor.id);

    // We drop messages for groups we already know about, which we're not a part of,
    //   except for group updates
    if (
      conversation &&
      !conversation.isPrivate() &&
      !conversation.hasMember(ourNumber) &&
      !isGroupUpdate
    ) {
      window.log.warn(
        `Received message destined for group ${conversation.idForLogging()}, which we're not a part of. Dropping.`
      );
      return event.confirm();
    }

    await ConversationController.getOrCreateAndWait(
      messageDescriptor.id,
      messageDescriptor.type
    );

    return message.handleDataMessage(data.message, event.confirm, {
      initialLoadComplete,
    });
  }

  // Sent:
  async function handleMessageSentProfileUpdate({
    data,
    confirm,
    messageDescriptor,
  }) {
    // First set profileSharing = true for the conversation we sent to
    const { id, type } = messageDescriptor;
    const conversation = await ConversationController.getOrCreateAndWait(
      id,
      type
    );

    conversation.set({ profileSharing: true });
    await window.Signal.Data.updateConversation(id, conversation.attributes, {
      Conversation: Whisper.Conversation,
    });

    // Then we update our own profileKey if it's different from what we have
    const ourNumber = textsecure.storage.user.getNumber();
    const profileKey = data.message.profileKey.toString('base64');
    const me = await ConversationController.getOrCreate(ourNumber, 'private');

    // Will do the save for us if needed
    await me.setProfileKey(profileKey);

    return confirm();
  }

  function createSentMessage(data) {
    const now = Date.now();
    let sentTo = [];

    if (data.unidentifiedStatus && data.unidentifiedStatus.length) {
      sentTo = data.unidentifiedStatus.map(item => item.destination);
      const unidentified = _.filter(data.unidentifiedStatus, item =>
        Boolean(item.unidentified)
      );
      // eslint-disable-next-line no-param-reassign
      data.unidentifiedDeliveries = unidentified.map(item => item.destination);
    }

    return new Whisper.Message({
      source: textsecure.storage.user.getNumber(),
      sourceDevice: data.device,
      sent_at: data.timestamp,
      sent_to: sentTo,
      received_at: now,
      conversationId: data.destination,
      type: 'outgoing',
      sent: true,
      unidentifiedDeliveries: data.unidentifiedDeliveries || [],
      expirationStartTimestamp: Math.min(
        data.expirationStartTimestamp || data.timestamp || Date.now(),
        Date.now()
      ),
    });
  }

  async function onSentMessage(event) {
    const { data, confirm } = event;

    const messageDescriptor = getDescriptorForSent(data);

    const { PROFILE_KEY_UPDATE } = textsecure.protobuf.DataMessage.Flags;
    // eslint-disable-next-line no-bitwise
    const isProfileUpdate = Boolean(data.message.flags & PROFILE_KEY_UPDATE);
    if (isProfileUpdate) {
      await handleMessageSentProfileUpdate({
        data,
        confirm,
        messageDescriptor,
      });
      return;
    }

    const message = await createSentMessage(data);
    const existing = await getExistingMessage(message);
    const isUpdate = Boolean(data.isRecipientUpdate);

    if (isUpdate && existing) {
      event.confirm();

      let sentTo = [];
      let unidentifiedDeliveries = [];
      if (Array.isArray(data.unidentifiedStatus)) {
        sentTo = data.unidentifiedStatus.map(item => item.destination);

        const unidentified = _.filter(data.unidentifiedStatus, item =>
          Boolean(item.unidentified)
        );
        unidentifiedDeliveries = unidentified.map(item => item.destination);
      }

      existing.set({
        sent_to: _.union(existing.get('sent_to'), sentTo),
        unidentifiedDeliveries: _.union(
          existing.get('unidentifiedDeliveries'),
          unidentifiedDeliveries
        ),
      });
      await window.Signal.Data.saveMessage(existing.attributes, {
        Message: Whisper.Message,
      });
    } else if (isUpdate) {
      window.log.warn(
        `onSentMessage: Received update transcript, but no existing entry for message ${message.idForLogging()}. Dropping.`
      );
    } else if (existing) {
      window.log.warn(
        `onSentMessage: Received duplicate transcript for message ${message.idForLogging()}, but it was not an update transcript. Dropping.`
      );
    } else {
      await ConversationController.getOrCreateAndWait(
        messageDescriptor.id,
        messageDescriptor.type
      );
      await message.handleDataMessage(data.message, event.confirm, {
        initialLoadComplete,
      });
    }
  }

  async function getExistingMessage(message) {
    try {
      const { attributes } = message;
      const result = await window.Signal.Data.getMessageBySender(attributes, {
        Message: Whisper.Message,
      });

      if (result) {
        return MessageController.register(result.id, result);
      }

      return null;
    } catch (error) {
      window.log.error('getExistingMessage error:', Errors.toLogFormat(error));
      return false;
    }
  }

  async function isMessageDuplicate(message) {
    const result = await getExistingMessage(message);
    return Boolean(result);
  }

  async function initIncomingMessage(data, options = {}) {
    const { isError } = options;

    const message = new Whisper.Message({
      source: data.source,
      sourceDevice: data.sourceDevice,
      sent_at: data.timestamp,
      received_at: data.receivedAt || Date.now(),
      conversationId: data.source,
      unidentifiedDeliveryReceived: data.unidentifiedDeliveryReceived,
      type: 'incoming',
      unread: 1,
    });

    // If we don't return early here, we can get into infinite error loops. So, no
    //   delivery receipts for sealed sender errors.
    if (isError || !data.unidentifiedDeliveryReceived) {
      return message;
    }

    try {
      const { wrap, sendOptions } = ConversationController.prepareForSend(
        data.source
      );
      await wrap(
        textsecure.messaging.sendDeliveryReceipt(
          data.source,
          data.timestamp,
          sendOptions
        )
      );
    } catch (error) {
      window.log.error(
        `Failed to send delivery receipt to ${data.source} for message ${
          data.timestamp
        }:`,
        error && error.stack ? error.stack : error
      );
    }

    return message;
  }

  async function onError(ev) {
    const { error } = ev;
    window.log.error('background onError:', Errors.toLogFormat(error));

    if (
      error &&
      error.name === 'HTTPError' &&
      (error.code === 401 || error.code === 403)
    ) {
      Whisper.events.trigger('unauthorized');

      if (messageReceiver) {
        await messageReceiver.stopProcessing();
        messageReceiver = null;
      }

      onEmpty();

      window.log.warn(
        'Client is no longer authorized; deleting local configuration'
      );
      Whisper.Registration.remove();

      const NUMBER_ID_KEY = 'number_id';
      const VERSION_KEY = 'version';
      const LAST_PROCESSED_INDEX_KEY = 'attachmentMigration_lastProcessedIndex';
      const IS_MIGRATION_COMPLETE_KEY = 'attachmentMigration_isComplete';

      const previousNumberId = textsecure.storage.get(NUMBER_ID_KEY);
      const lastProcessedIndex = textsecure.storage.get(
        LAST_PROCESSED_INDEX_KEY
      );
      const isMigrationComplete = textsecure.storage.get(
        IS_MIGRATION_COMPLETE_KEY
      );

      try {
        await textsecure.storage.protocol.removeAllConfiguration();

        // These two bits of data are important to ensure that the app loads up
        //   the conversation list, instead of showing just the QR code screen.
        Whisper.Registration.markEverDone();
        textsecure.storage.put(NUMBER_ID_KEY, previousNumberId);

        // These two are important to ensure we don't rip through every message
        //   in the database attempting to upgrade it after starting up again.
        textsecure.storage.put(
          IS_MIGRATION_COMPLETE_KEY,
          isMigrationComplete || false
        );
        textsecure.storage.put(
          LAST_PROCESSED_INDEX_KEY,
          lastProcessedIndex || null
        );
        textsecure.storage.put(VERSION_KEY, window.getVersion());

        window.log.info('Successfully cleared local configuration');
      } catch (eraseError) {
        window.log.error(
          'Something went wrong clearing local configuration',
          eraseError && eraseError.stack ? eraseError.stack : eraseError
        );
      }

      return;
    }

    if (error && error.name === 'HTTPError' && error.code === -1) {
      // Failed to connect to server
      if (navigator.onLine) {
        window.log.info('retrying in 1 minute');
        setTimeout(connect, 60000);

        Whisper.events.trigger('reconnectTimer');
      }
      return;
    }

    if (ev.proto) {
      if (error && error.name === 'MessageCounterError') {
        if (ev.confirm) {
          ev.confirm();
        }
        // Ignore this message. It is likely a duplicate delivery
        // because the server lost our ack the first time.
        return;
      }
      const envelope = ev.proto;
      const message = await initIncomingMessage(envelope, { isError: true });
      const isDuplicate = await isMessageDuplicate(message);
      if (isDuplicate) {
        ev.confirm();
        window.log.warn(
          `Got duplicate error for message ${message.idForLogging()}`
        );
        return;
      }

      await message.saveErrors(error || new Error('Error was null'));
      const id = message.get('conversationId');
      const conversation = await ConversationController.getOrCreateAndWait(
        id,
        'private'
      );
      conversation.set({
        active_at: Date.now(),
        unreadCount: conversation.get('unreadCount') + 1,
      });

      const conversationTimestamp = conversation.get('timestamp');
      const messageTimestamp = message.get('timestamp');
      if (!conversationTimestamp || messageTimestamp > conversationTimestamp) {
        conversation.set({ timestamp: message.get('sent_at') });
      }

      conversation.trigger('newmessage', message);
      conversation.notify(message);

      if (ev.confirm) {
        ev.confirm();
      }

      await window.Signal.Data.updateConversation(id, conversation.attributes, {
        Conversation: Whisper.Conversation,
      });
    }

    throw error;
  }

  function onReadReceipt(ev) {
    const readAt = ev.timestamp;
    const { timestamp } = ev.read;
    const { reader } = ev.read;
    window.log.info('read receipt', reader, timestamp);

    if (!storage.get('read-receipt-setting')) {
      return ev.confirm();
    }

    const receipt = Whisper.ReadReceipts.add({
      reader,
      timestamp,
      read_at: readAt,
    });

    receipt.on('remove', ev.confirm);

    // Calling this directly so we can wait for completion
    return Whisper.ReadReceipts.onReceipt(receipt);
  }

  function onReadSync(ev) {
    const readAt = ev.timestamp;
    const { timestamp } = ev.read;
    const { sender } = ev.read;
    window.log.info('read sync', sender, timestamp);

    const receipt = Whisper.ReadSyncs.add({
      sender,
      timestamp,
      read_at: readAt,
    });

    receipt.on('remove', ev.confirm);

    // Calling this directly so we can wait for completion
    return Whisper.ReadSyncs.onReceipt(receipt);
  }

  async function onVerified(ev) {
    const number = ev.verified.destination;
    const key = ev.verified.identityKey;
    let state;

    const c = new Whisper.Conversation({
      id: number,
    });
    const error = c.validateNumber();
    if (error) {
      window.log.error(
        'Invalid verified sync received:',
        Errors.toLogFormat(error)
      );
      return;
    }

    switch (ev.verified.state) {
      case textsecure.protobuf.Verified.State.DEFAULT:
        state = 'DEFAULT';
        break;
      case textsecure.protobuf.Verified.State.VERIFIED:
        state = 'VERIFIED';
        break;
      case textsecure.protobuf.Verified.State.UNVERIFIED:
        state = 'UNVERIFIED';
        break;
      default:
        window.log.error(`Got unexpected verified state: ${ev.verified.state}`);
    }

    window.log.info(
      'got verified sync for',
      number,
      state,
      ev.viaContactSync ? 'via contact sync' : ''
    );

    const contact = await ConversationController.getOrCreateAndWait(
      number,
      'private'
    );
    const options = {
      viaSyncMessage: true,
      viaContactSync: ev.viaContactSync,
      key,
    };

    if (state === 'VERIFIED') {
      await contact.setVerified(options);
    } else if (state === 'DEFAULT') {
      await contact.setVerifiedDefault(options);
    } else {
      await contact.setUnverified(options);
    }

    if (ev.confirm) {
      ev.confirm();
    }
  }

  function onDeliveryReceipt(ev) {
    const { deliveryReceipt } = ev;
    window.log.info(
      'delivery receipt from',
      `${deliveryReceipt.source}.${deliveryReceipt.sourceDevice}`,
      deliveryReceipt.timestamp
    );

    const receipt = Whisper.DeliveryReceipts.add({
      timestamp: deliveryReceipt.timestamp,
      source: deliveryReceipt.source,
    });

    ev.confirm();

    // Calling this directly so we can wait for completion
    return Whisper.DeliveryReceipts.onReceipt(receipt);
  }
})();
