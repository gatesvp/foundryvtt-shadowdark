/* eslint-disable no-unused-expressions */
/**
 * @file Contains tests for the migrations
 */

import { _migrateHpBase } from "../migration.mjs";

export const key = "shadowdark.root.migrations";
export const options = {
	displayName: "Shadowdark: Migrations",
	preSelected: true,
};

export default ({ describe, it, after, beforeEach, before, expect }) => {
	describe("actor HP migrations", () => {
		const actorPreMigrationBonus = {
			system: {
				attributes: {
					hp: {
						max: 8,
						value: 10,
						bonus: 2,
					},
				},
			},
		};

		const actorPreMigration = {
			system: {
				attributes: {
					hp: {
						max: 10,
						value: 10,
						bonus: 0,
					},
				},
			},
		};


		it("migrates actor with bonus correctly", () => {
			const migratedData = _migrateHpBase(actorPreMigrationBonus, {});
			expect(Object.keys(migratedData).includes("system.attributes.hp.base")).is.true;
			expect(Object.keys(migratedData).includes("system.attributes.hp.max")).is.true;
			expect(migratedData["system.attributes.hp.base"]).equal(8);
			expect(migratedData["system.attributes.hp.max"]).equal(10);
		});

		it("migrates actor without bonus correctly", () => {
			const migratedData = _migrateHpBase(actorPreMigration, {});
			expect(Object.keys(migratedData).includes("system.attributes.hp.base")).is.true;
			expect(Object.keys(migratedData).includes("system.attributes.hp.max")).is.true;
			expect(migratedData["system.attributes.hp.base"]).equal(10);
			expect(migratedData["system.attributes.hp.max"]).equal(10);
		});
	});
};
