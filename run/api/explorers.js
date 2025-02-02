const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const router = express.Router();
const { isStripeEnabled } = require('../lib/flags');
const { getAppDomain, getDefaultPlanSlug, getDefaultExplorerTrialDays } = require('../lib/env');
const { ProviderConnector } = require('../lib/rpc');
const { Explorer } = require('../models');
const { withTimeout } = require('../lib/utils');
const { bulkEnqueue } = require('../lib/queue');
const logger = require('../lib/logger');
const PM2 = require('../lib/pm2');
const db = require('../lib/firebase');
const authMiddleware = require('../middlewares/auth');
const stripeMiddleware = require('../middlewares/stripe');
const secretMiddleware = require('../middlewares/secret');

router.post('/:id/startTrial', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        if (!data.stripePlanSlug)
            throw new Error('Missing parameter');

        const user = await db.getUser(data.uid, ['stripeCustomerId', 'canTrial']);
        if (!user)
            throw new Error('Could not find user.');

        if (!user.canTrial)
            throw new Error(`You've already used your trial.`);

        const explorer = await db.getExplorerById(user.id, req.params.id);
        if (!explorer)
            throw new Error('Could not find explorer.');

        const plan = await db.getStripePlan(data.stripePlanSlug);
        if (!plan)
            throw new Error('Could not find plan.');

        const subscription = await stripe.subscriptions.create({
            customer: user.stripeCustomerId,
            items: [{ price: plan.stripePriceId }],
            trial_period_days: getDefaultExplorerTrialDays(),
            trial_settings: {
                end_behavior: { missing_payment_method: 'cancel' }
            },
            metadata: { explorerId: explorer.id }
        });

        if (!subscription)
            throw new Error('Error while starting trial. Please try again.')

        const customer = await stripe.customers.retrieve(subscription.customer);

        await db.createExplorerSubscription(user.id, explorer.id,  plan.id, { ...subscription, customer });
        await db.disableUserTrial(user.id);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.startTrial', error });
        res.status(400).send(error.message);
    }
});

router.post('/syncExplorers', secretMiddleware, async (req, res) => {
    try {
        const explorers = await Explorer.findAll();

        const jobs = [];
        for (let i = 0; i < explorers.length; i++) {
            const explorer = explorers[i];
            jobs.push({
                name: `updateExplorerSyncingProcess-${explorer.id}`,
                data: { explorerSlug: explorer.slug }
            });
        }

        await bulkEnqueue('updateExplorerSyncingProcess', jobs);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.syncExplorers', error });
        res.status(400).send(error.message);
    }
});

router.put('/:id/stopSync', [authMiddleware], async (req, res) => {
    try {
        if (!req.params.id)
            throw new Error('Missing parameters');

        const explorer = await db.getExplorerById(req.body.data.user.id, req.params.id);
        if (!explorer)
            throw new Error(`Couldn't find explorer.`);

        // We rely on the afterUpdate hook to update the pm2 process. The frontend needs to take care of waiting for the new state
        await db.stopExplorerSync(explorer.id);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'put.api.explorers.id.stopSync', error });
        res.status(400).send(error.message);
    }
});

router.put('/:id/startSync', [authMiddleware], async (req, res) => {
    try {
        if (!req.params.id)
            throw new Error('Missing parameters');

        const explorer = await db.getExplorerById(req.body.data.user.id, req.params.id);

        if (!explorer)
            throw new Error(`Couldn't find explorer.`);

        if (!explorer.stripeSubscription)
            throw new Error(`No active subscription for this explorer.`);

        if (await explorer.hasReachedTransactionQuota())
            throw new Error('Transaction quota reached. Upgrade your plan to resume sync.');

        const provider = new ProviderConnector(explorer.workspace.rpcServer);
        try {
            await withTimeout(provider.fetchNetworkId());
        } catch(error) {
            throw new Error(`This explorer's RPC is not reachable. Please update it in order to start syncing.`);
        }

        // We rely on the afterUpdate hook to update the pm2 process. The frontend needs to take care of waiting for the new state
        await db.startExplorerSync(explorer.id);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'put.api.explorers.id.startSync', error });
        res.status(400).send(error.message);
    }
});

router.get('/:id/syncStatus', [authMiddleware], async (req, res) => {
    try {
        if (!req.params.id)
            throw new Error('Missing parameters');

        const explorer = await db.getExplorerById(req.body.data.user.id, req.params.id);
        if (!explorer)
            throw new Error(`Can't find explorer.`);

        let status;
        if (explorer.workspace.rpcHealthCheck && !explorer.workspace.rpcHealthCheck.isReachable) {
            status = 'unreachable';
        }
        else if (await explorer.hasReachedTransactionQuota()) {
            status = 'transactionQuotaReached';
        }
        else {
            const pm2 = new PM2(process.env.PM2_HOST, process.env.PM2_SECRET);
            const { data: { pm2_env: pm2Process }} = await pm2.find(explorer.slug);
            status = pm2Process ? pm2Process.status : 'stopped';
        }

        res.status(200).json({ status });
    } catch(error) {
        logger.error(error.message, { location: 'get.api.explorers.id.syncStatus', error });
        res.status(400).send(error.message);
    }
});

router.put('/:id/subscription', [authMiddleware, stripeMiddleware], async (req, res) => {
    const data = req.body.data;

    try {
        if (!data.newStripePlanSlug)
            throw new Error('Missing parameters.');

        const explorer = await db.getExplorerById(data.user.id, req.params.id);

        if (!explorer || !explorer.stripeSubscription)
            throw new Error(`Can't find explorer.`);

        if (explorer.stripeSubscription.stripePlan.slug != data.newStripePlanSlug && explorer.stripeSubscription.isPendingCancelation)
            throw new Error(`Revert plan cancelation before choosing a new plan.`);

        const stripePlan = await db.getStripePlan(data.newStripePlanSlug);
        if (!stripePlan || !stripePlan.public)
            throw new Error(`Can't find plan.`);

        let subscription;
        if (explorer.stripeSubscription.stripeId) {
            subscription = await stripe.subscriptions.retrieve(explorer.stripeSubscription.stripeId, { expand: ['customer']});
            await stripe.subscriptions.update(subscription.id, {
                cancel_at_period_end: false,
                proration_behavior: 'always_invoice',
                items: [{
                    id: subscription.items.data[0].id,
                    price: stripePlan.stripePriceId
                }]
            });
        }

        if (explorer.stripeSubscription.isPendingCancelation)
            await db.revertExplorerSubscriptionCancelation(data.user.id, explorer.id);
        else
            await db.updateExplorerSubscription(data.user.id, explorer.id, stripePlan.id, subscription);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.id.updateSubscription', error: error, data: data });
        res.status(400).send(error.message);
    }
});

router.delete('/:id/subscription', [authMiddleware, stripeMiddleware], async (req, res) => {
    const data = req.body.data;

    try {
        const explorer = await db.getExplorerById(data.user.id, req.params.id);

        if (!explorer || !explorer.stripeSubscription)
            throw new Error(`Can't find explorer.`);

        if (explorer.stripeSubscription.stripeId) {
            const subscription = await stripe.subscriptions.retrieve(explorer.stripeSubscription.stripeId);
            await stripe.subscriptions.update(subscription.id, {
                cancel_at_period_end: true,
            });
        }

        await db.cancelExplorerSubscription(data.user.id, explorer.id);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.id.cancelSubscription', error: error, data: data });
        res.status(400).send(error.message);
    }
});

router.post('/:id/cryptoSubscription', [authMiddleware, stripeMiddleware], async (req, res) => {
    const data = req.body.data;

    try {
        if (!data.stripePlanSlug)
            throw new Error('Missing parameter');

        if (!data.user.cryptoPaymentEnabled)
            throw new Error(`Crypto payment is not available for your account. Please reach out to contact@tryethernal.com if you'd like to enable it.`);

        const explorer = await db.getExplorerById(data.user.id, req.params.id, true);
        if (!explorer)
            throw new Error(`Can't find explorer.`);

        const stripePlan = await db.getStripePlan(data.stripePlanSlug);
        if (!stripePlan || !stripePlan.public)
            throw new Error(`Can't find plan.`);

        await stripe.subscriptions.create({
            customer: data.user.stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: getDefaultExplorerTrialDays(),
            items: [
                { price: stripePlan.stripePriceId }
            ],
            metadata: {
                explorerId: explorer.id
            }
        });

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.id.startCryptoSubscription', error: error, data: data });
        res.status(400).send(error.message);
    }
});

router.delete('/:id', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        await db.deleteExplorer(data.user.id, req.params.id);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'delete.api.explorers.id', error, data });
        res.status(400).send(error.message);
    }
});

router.get('/plans', [authMiddleware, stripeMiddleware], async (req, res) => {
    try {
        const plans = await db.getExplorerPlans();

        res.status(200).json(plans);
    } catch(error) {
        logger.error(error.message, { location: 'get.api.explorers.plans', error: error });
        res.status(400).send(error.message);
    }
});

router.post('/:id/domains', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        if (!data.domain)
            throw new Error('Missing parameter');

        if (data.domain.endsWith(getAppDomain()))
            throw new Error(`You can only have one ${getAppDomain()} domain. If you'd like a different one, update the "Ethernal Domain" field, in the "Settings" panel.`)

        const explorer = await db.getExplorerById(data.user.id, req.params.id);
        if (!explorer)
            throw new Error('Could not find explorer.');

        await db.createExplorerDomain(explorer.id, data.domain);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.id.domains', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.post('/:id/branding', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        const explorer = await db.getExplorerById(data.user.id, req.params.id);
        if (!explorer)
            throw new Error('Could not find explorer.');

        await db.updateExplorerBranding(explorer.id, data);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.id.branding', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.post('/:id/settings', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        const explorer = await db.getExplorerById(data.user.id, req.params.id);
        if (!explorer || !explorer.workspace)
            throw new Error('Could not find explorer.');

        if (data.workspace && data.workspace != explorer.workspace.name) {
            const workspace = await db.getWorkspaceByName(data.uid, data.workspace);
            if (!workspace)
                throw new Error('Invalid workspace.');
            else
                await db.updateExplorerWorkspace(explorer.id, workspace.id);
        }

        await db.updateExplorerSettings(explorer.id, data);

        res.sendStatus(200);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers.settings', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.post('/', authMiddleware, async (req, res) => {
    const data = req.body.data;

    try {
        if (!data.workspaceId && !(data.rpcServer && data.name))
            throw new Error('Missing parameters.');

        const user = await db.getUser(data.uid, ['stripeCustomerId', 'canUseDemoPlan']);

        let explorer;
        if (data.workspaceId) {
            const workspace = await db.getWorkspaceById(data.workspaceId);
            if (!workspace)
                throw new Error('Invalid workspace.');

            if (workspace.explorer)
                throw new Error('This workspace already has an explorer.');

            const provider = new ProviderConnector(workspace.rpcServer);
            try {
                await withTimeout(provider.fetchNetworkId());
            } catch(error) {
                throw new Error(`Our servers can't query this rpc, please use a rpc that is reachable from the internet.`);
            }

            explorer = await db.createExplorerFromWorkspace(user.id, workspace.id);
        }
        else {
            const provider = new ProviderConnector(data.rpcServer);
            let networkId;
            try {
                networkId = await withTimeout(provider.fetchNetworkId());
            } catch(error) {
                networkId = null;
            }

            if (!networkId)
                throw new Error(`Our servers can't query this rpc, please use a rpc that is reachable from the internet.`);

            const workspaceData = {
                name: data.name,
                networkId,
                rpcServer: data.rpcServer,
                tracing: data.tracing,
                dataRetentionLimit: user.defaultDataRetentionLimit
            }

            explorer = await db.createExplorerWithWorkspace(user.id, workspaceData);
        }

        if (!explorer)
            throw new Error('Could not create explorer.');

        if (!isStripeEnabled() || user.canUseDemoPlan) {
            const stripePlan = await db.getStripePlan(getDefaultPlanSlug());
            if (!stripePlan)
                throw new Error(`Can't setup explorer. Make sure you've run npx sequelize-cli db:seed:all`);

            await db.createExplorerSubscription(user.id, explorer.id, stripePlan.id);
        }
        else if (req.query.startSubscription) {
            if (!data.plan)
                throw new Error('Missing plan parameter.');

            const stripePlan = await db.getStripePlan(data.plan);
            if (!stripePlan || !stripePlan.public)
                throw new Error(`Can't find plan.`);

            let stripeParams = {
                customer: user.stripeCustomerId,
                items: [
                    { price: stripePlan.stripePriceId }
                ],
                metadata: {
                    explorerId: explorer.id
                }
            };

            if (!user.cryptoPaymentEnabled) {
                const stripeCustomer = await stripe.customers.retrieve(user.stripeCustomerId);
                if (!stripeCustomer.default_source)
                    throw new Error(`There doesn't seem to be a payment method associated to your account. If you never subscribed to an explorer plan, please start your first one using the dashboard. You can also reach out to support on Discord or at contact@tryethernal.com.`);
            }
            else {
                stripeParams['collection_method'] = 'send_invoice';
                stripeParams['days_until_due'] = 7;
            }

            await stripe.subscriptions.create(stripeParams);
        }

        res.status(200).send(explorer);
    } catch(error) {
        logger.error(error.message, { location: 'post.api.explorers', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.get('/search', async (req, res) => {
    const data = req.query;

    try {
        if (!data.domain)
            throw new Error('Missing parameters.')

        let explorer;

        if (data.domain == `app.${getAppDomain()}`)
            return res.sendStatus(200);

        if (data.domain.endsWith(getAppDomain())) {
            const slug = data.domain.split(`.${getAppDomain()}`)[0];
            explorer = await db.getPublicExplorerParamsBySlug(slug);
        }

        if (!explorer)
            explorer = await db.getPublicExplorerParamsByDomain(data.domain); // This method will return null if the current explorer plan doesn't have the "customDomain" capability

        if (!explorer)
            throw new Error(`Couldn't find explorer.`);

        if (!explorer.stripeSubscription)
            throw new Error('This explorer is not active.');

        const capabilities = explorer.stripeSubscription.stripePlan.capabilities;

        if (!capabilities.nativeToken)
            explorer.token = 'ether';
        if (!capabilities.totalSupply)
            delete explorer.totalSupply;
        if (!capabilities.branding)
            explorer.themes = { 'default': {}};

        res.status(200).json({ explorer });
    } catch(error) {
        logger.error(error.message, { location: 'get.api.explorers.search', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.get('/:id', authMiddleware, async (req, res) => {
    const data = req.params;

    try {
        if (!data.id)
            throw new Error('Missing parameters.')

        const explorer = await db.getExplorerById(req.body.data.user.id, data.id);

        if (!explorer)
            throw new Error('Could not find explorer.');

        res.status(200).json(explorer.toJSON());
    } catch(error) {
        logger.error(error.message, { location: 'get.api.explorers.id', error: error, data: data, queryParams: req.params });
        res.status(400).send(error.message);
    }
});

router.get('/', authMiddleware, async (req, res) => {
    const data = { ...req.body.data, ...req.query };

    try {
        const explorers = await db.getUserExplorers(data.user.id, data.page, data.itemsPerPage, data.order, data.orderBy)

        res.status(200).json(explorers)
    } catch(error) {
        logger.error(error.message, { location: 'get.api.explorers', error: error, data: data });
        res.status(400).send(error.message);
    }
});

module.exports = router;
