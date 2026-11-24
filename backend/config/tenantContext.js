
const { AsyncLocalStorage } = require("async_hooks");

const tenantStorage = new AsyncLocalStorage();

// Get current tenant's database client
const getTenantClient = () => {
  const store = tenantStorage.getStore();
  return store ? store.client : null;
};

// Get current tenant ID
const getTenantId = () => {
  const store = tenantStorage.getStore();
  return store ? store.tenantId : null;
};

// Run request inside tenant context
const runWithTenant = (client, tenantId, callback) => {
  return tenantStorage.run(
    {
      client,
      tenantId,
    },
    callback
  );
};

module.exports = {
  getTenantClient,
  getTenantId,
  runWithTenant,
};
