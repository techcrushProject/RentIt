const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const equipmentModel = require("../model/equipmentModel");
const equipmentRoutes = require("../route/equipmentRoute");
const adminEquipmentRoutes = require("../route/adminEquipmentRoute");

process.env.JWT_SECRET = "equipment-workflow-test-secret";

const restoreMocks = [];
const fixtureId = () => new mongoose.Types.ObjectId().toString();
const replace = (object, key, value) => {
  const original = object[key];
  object[key] = value;
  restoreMocks.push(() => { object[key] = original; });
};
const makeQuery = value => ({
  populate() { return this; },
  sort() { return this; },
  then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
});

afterEach(() => {
  while (restoreMocks.length) restoreMocks.pop()();
});

const startApi = async records => {
  replace(equipmentModel, "create", async data => {
    const equipment = { ...data, _id: fixtureId(), async save() {} };
    records.push(equipment);
    return equipment;
  });
  replace(equipmentModel, "find", filter => makeQuery(records.filter(record =>
    Object.entries(filter).every(([key, value]) => record[key]?.toString() === value?.toString())
  )));
  replace(equipmentModel, "findById", async id => records.find(record => record._id === id) || null);
  replace(equipmentModel, "findOne", filter => makeQuery(records.find(record =>
    Object.entries(filter).every(([key, value]) => record[key]?.toString() === value?.toString())
  ) || null));

  const app = express();
  app.use(express.json());
  app.use("/equipment", equipmentRoutes);
  app.use("/admin/equipment", adminEquipmentRoutes);
  app.use("/api/equipment", equipmentRoutes);
  app.use("/api/admin/equipment", adminEquipmentRoutes);
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
};

const tokenFor = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET);
const request = async (baseUrl, path, { method = "GET", token, body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

test("owner submission starts pending, is visible to admin, and review feedback returns to owner", async () => {
  const records = [];
  const ownerId = fixtureId();
  const adminId = fixtureId();
  const categoryId = fixtureId();
  const api = await startApi(records);
  try {
    const created = await request(api.baseUrl, "/api/equipment", {
      method: "POST",
      token: tokenFor(ownerId, "owner"),
      body: {
        title: "Workflow camera",
        description: "Camera for listing workflow",
        category: categoryId,
        owner: fixtureId(),
        location: "Test City",
        price: 25,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.equipment.name, "Workflow camera");
    assert.equal(created.body.equipment.pricePerDay, 25);
    assert.equal(created.body.equipment.status, "pending");
    assert.equal(created.body.equipment.owner, ownerId);

    const adminQueue = await request(api.baseUrl, "/api/admin/equipment", { token: tokenFor(adminId, "admin") });
    assert.equal(adminQueue.status, 200);
    assert.equal(adminQueue.body.equipment[0]._id, created.body.equipment._id);

    const decision = await request(api.baseUrl, `/api/admin/equipment/${created.body.equipment._id}/review`, {
      method: "PUT",
      token: tokenFor(adminId, "admin"),
      body: { status: "rejected", reviewNote: "Please provide clearer photos" },
    });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.ownerResponse.message, "Please provide clearer photos");

    const ownerListings = await request(api.baseUrl, "/api/equipment/mine", { token: tokenFor(ownerId, "owner") });
    assert.equal(ownerListings.status, 200);
    assert.equal(ownerListings.body.equipment[0].status, "rejected");
    assert.equal(ownerListings.body.equipment[0].reviewNote, "Please provide clearer photos");
  } finally {
    await api.close();
  }
});

test("only approved and available equipment appears in the renter Explore feed", async () => {
  const records = [
    { _id: fixtureId(), status: "pending", availability: true },
    { _id: fixtureId(), status: "rejected", availability: false },
    { _id: fixtureId(), status: "approved", availability: false },
    { _id: fixtureId(), status: "approved", availability: true },
  ];
  const api = await startApi(records);
  try {
    const result = await request(api.baseUrl, "/api/equipment");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.equipment.map(item => item._id), [records[3]._id]);
  } finally {
    await api.close();
  }
});

test("listing review routes enforce owner and admin roles", async () => {
  const api = await startApi([]);
  try {
    assert.equal((await request(api.baseUrl, "/api/equipment/mine")).status, 401);
    assert.equal((await request(api.baseUrl, "/api/admin/equipment", { token: tokenFor(fixtureId(), "owner") })).status, 403);
    assert.equal((await request(api.baseUrl, "/api/equipment", {
      method: "POST",
      token: tokenFor(fixtureId(), "renter"),
      body: {},
    })).status, 403);
  } finally {
    await api.close();
  }
});
