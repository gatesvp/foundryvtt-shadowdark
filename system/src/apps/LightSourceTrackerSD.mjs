import RealTimeSD from "./RealTimeSD.mjs";

export default class LightSourceTrackerSD extends Application {

	DEFAULT_UPDATE_INTERVAL =
		shadowdark.defaults.LIGHT_TRACKER_UPDATE_INTERVAL_SECS;

	constructor(object, options) {
		super(object, options);

		this.monitoredLightSources = [];

		this.lastUpdate = 0;
		this.updatingLightSources = false;

		this.housekeepingInterval = 1000; // 1 sec
		this.housekeepingIntervalId = null;

		this.dirty = true;

		this.performingTick = false;
		this.realTime = new RealTimeSD();

		this.showUserWarning = false;
	}

	/** @inheritdoc */
	static get defaultOptions() {
		return foundry.utils.mergeObject(super.defaultOptions, {
			classes: ["shadowdark", "light-tracker"],
			height: "auto",
			resizable: false,
			width: "auto",
		});
	}

	/** @inheritdoc */
	get template() {
		return "systems/shadowdark/templates/apps/light-tracker.hbs";
	}

	/** @inheritdoc */
	get title() {
		return game.i18n.localize("SHADOWDARK.app.light_tracker.title");
	}

	activateListeners(html) {
		html.find(".character-portrait").click(
			async event => {
				event.preventDefault();

				const actorId = $(event.currentTarget).data("actor-id");

				const actor = game.actors.get(actorId);

				if (actor.sheet.rendered) {
					actor.sheet.close();
				}
				else {
					actor.sheet.render(true);
				}
			}
		);

		html.find(".disable-all-lights").click(
			async event => {
				event.preventDefault();

				shadowdark.log("Turning out all the lights");

				if (this.monitoredLightSources.length <= 0) return;

				for (const actorData of this.monitoredLightSources) {
					if (actorData.lightSources.length <= 0) continue;

					const actor = game.actors.get(actorData._id);

					for (const itemData of actorData.lightSources) {
						shadowdark.log(`Turning off ${actor.name}'s ${itemData.name} light source`);

						await actor.updateEmbeddedDocuments("Item", [{
							_id: itemData._id,
							"system.light.active": false,
						}]);

						actor.turnLightOff();
					}
				}

				const cardData = {
					img: "icons/magic/perception/shadow-stealth-eyes-purple.webp",
					actor: this,
					message: game.i18n.localize("SHADOWDARK.chat.light_source.source.all"),
				};

				let template = "systems/shadowdark/templates/chat/lightsource-toggle-gm.hbs";

				const content = await renderTemplate(template, cardData);

				await ChatMessage.create({
					content,
					rollMode: CONST.DICE_ROLL_MODES.PUBLIC,
				});

				this.dirty = true;
				this._updateLightSources();
			}
		);

		html.find(".disable-light").click(
			async event => {
				event.preventDefault();
				const itemId = $(event.currentTarget).data("item-id");
				const actorId = $(event.currentTarget).data("actor-id");

				const actor = game.actors.get(actorId);
				const item = actor.getEmbeddedDocument("Item", itemId);

				shadowdark.log(`Turning off ${actor.name}'s ${item.name} light source`);

				const active = !item.system.light.active;

				const dataUpdate = {
					_id: itemId,
					"system.light.active": active,
				};

				actor.updateEmbeddedDocuments("Item", [dataUpdate]);

				actor.yourLightWentOut(itemId);

				this.dirty = true;
				this._updateLightSources();
			}
		);
	}

	/** @override */
	async getData(options) {
		const context = {
			monitoredLightSources: this.monitoredLightSources,
			isRealtimeEnabled: this.realTime.isEnabled(),
			paused: this._isPaused(),
			showUserWarning: this.showUserWarning,
		};

		return context;
	}

	async render(force, options) {
		// Don't allow non-GM users to view the UI
		if (!game.user.isGM) return;

		super.render(force, options);
	}

	async start() {
		// Make sure we're actualled enable and are supposed to be running.
		if (this._isDisabled()) {
			shadowdark.log("Light Tracker is disabled in settings");
			return;
		}

		// we only run the timer on the GM instance
		if (!game.user.isGM) return;

		// Now we can actually start properly
		shadowdark.log("Light Tracker starting");

		// Start the realtime clock (if enabled).
		this.realTime.start();

		// First get a list of all active light sources in the world
		await this._gatherLightSources();

		// Setup the housekeeping interval which will check for changes
		// to lightsources
		this.housekeepingIntervalId = setInterval(
			this._updateLightSources.bind(this),
			this.housekeepingInterval
		);

		if (game.settings.get("shadowdark", "trackLightSourcesOpen")) {
			this.render(true);
		}
	}

	async toggleInterface(force=false) {
		if (!force && !game.user.isGM) {
			ui.notifications.error(
				game.i18n.localize("SHADOWDARK.error.general.gm_required")
			);
			return;
		}

		if (this.rendered) {
			this.close();
		}
		else {
			this.render(true);
		}
	}

	async toggleLightSource(actor, item) {
		if (this._isDisabled()) return;

		if (!game.user.isGM) {
			game.socket.emit(
				"system.shadowdark",
				{
					type: "toggleLightSource",
					data: {
						actor,
						item,
					},
				}
			);
			return;
		}

		const status = item.system.light.active ? "on" : "off";

		shadowdark.log(`Turning ${status} ${actor.name}'s ${item.name} light source`);

		this._onToggleLightSource();
	}

	async _deleteActorHook(actor, options, userId) {
		if (!(this._isEnabled() && game.user.isGM)) return;

		if (actor.hasActiveLightSources()) this.dirty = true;
	}

	async _deleteItemHook(item, options, userId) {
		if (!(this._isEnabled() && game.user.isGM)) return;

		if (item.isActiveLight()) this.dirty = true;
	}

	async _gatherLightSources() {
		if (this.performingTick) return;
		if (this.updatingLightSources) return;
		if (!this.dirty) return;

		this.updatingLightSources = true;
		this.dirty = false;

		shadowdark.log("Checking for new/changed light sources");

		this.monitoredLightSources = [];

		const workingLightSources = [];

		let usersWithoutCharacters = 0;
		try {
			for (const user of game.users) {
				if (user.isGM) continue;

				if (!(user.active || this._monitorInactiveUsers())) continue;

				const actor = user.character;
				if (!actor) {
					usersWithoutCharacters++;
					continue;
				}

				const actorData = actor.toObject(false);
				actorData.lightSources = [];

				const activeLightSources = await actor.getActiveLightSources();

				for (const item of activeLightSources) {
					actorData.lightSources.push(
						item.toObject(false)
					);
				}

				workingLightSources.push(actorData);
			}

			this.showUserWarning = usersWithoutCharacters > 0 ? true : false;

			this.monitoredLightSources = workingLightSources.sort((a, b) => {
				if (a.name < b.name) {
					return -1;
				}
				if (a.name > b.name) {
					return 1;
				}
				return 0;
			});
		}
		catch(error) {
			console.error(error);
		}
		finally {
			this.updatingLightSources = false;
		}
	}

	_isDisabled() {
		return !this._isEnabled();
	}

	_isEnabled() {
		return game.settings.get("shadowdark", "trackLightSources");
	}

	async _makeDirty() {
		if (this._isEnabled() && game.user.isGM) this.dirty = true;
	}

	_monitorInactiveUsers() {
		return game.settings.get("shadowdark", "trackInactiveUserLightSources");
	}

	async _onToggleLightSource() {
		if (!(this._isEnabled() && game.user.isGM)) return;
		this.dirty = true;
	}

	async _pauseGameHook() {
		this.render(false);
	}

	async onUpdateWorldTime(worldTime, worldDelta) {
		if (!(this._isEnabled() && game.user.isGM)) return;
		if (this.updatingLightSources) return;

		this.performingTick = true;

		const updateSecs = game.settings.get(
			"shadowdark", "trackLightSourcesInterval"
		) || this.DEFAULT_UPDATE_INTERVAL;

		// If time moves forward, check if enough time has passed to update the
		// light timers. Updating too often results in inventory rerendering. If
		// the time moved backwards, always update.
		const delta = worldTime - this.lastUpdate;
		if (worldDelta > 0 && delta < updateSecs) {
			return;
		}
		this.lastUpdate = worldTime;

		shadowdark.log("Updating light sources");

		try {
			for (const actorData of this.monitoredLightSources) {
				const numLightSources = actorData.lightSources.length;

				shadowdark.log(`Updating ${numLightSources} light sources for ${actorData.name}`);

				for (const itemData of actorData.lightSources) {
					const actor = await game.actors.get(actorData._id);

					const light = itemData.system.light;

					const longevitySecs = light.longevityMins * 60;
					light.remainingSecs = Math.max(
						0,
						Math.min(longevitySecs, light.remainingSecs - delta)
					);

					if (light.remainingSecs <= 0) {
						shadowdark.log(`Light source ${itemData.name} owned by ${actorData.name} has expired`);

						await actor.yourLightExpired(itemData._id);

						actor.deleteEmbeddedDocuments("Item", [itemData._id]);
					}
					else {
						shadowdark.log(`Light source ${itemData.name} owned by ${actorData.name} has ${Math.ceil(light.remainingSecs)} seconds remaining`);

						const item = await actor.getEmbeddedDocument(
							"Item", itemData._id
						);

						item.update({
							"system.light.remainingSecs": light.remainingSecs,
						});
					}
				}
			}

			this.render(false);
		}
		catch(error) {
			shadowdark.log(`An error ocurred updating light sources: ${error}`);
			console.error(error);
		}
		finally {
			this.performingTick = false;
		}

		shadowdark.log("Finished updating light sources");
	}

	async _settingsChanged() {
		if (!game.user.isGM) return;

		if (this.realTime.isEnabled()) {
			this.realTime.start();
		}
		else {
			this.realTime.stop();
		}

		if (this._isEnabled()) {
			this.dirty = true;
			await this._updateLightSources();
			this.render(true);
		}
		else {
			this.close();
			this.monitoredLightSources = {};
		}
		this.render(false);
	}

	async _updateLightSources() {
		if (!(this._isEnabled() && game.user.isGM)) return;
		if (!this.dirty) return;
		if (this.performingTick) return;

		await this._gatherLightSources();

		this.render(false);
	}

	_isPaused() {
		return this.realTime.isPaused();
	}
}
