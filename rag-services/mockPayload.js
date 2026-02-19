// mockPayload.js

const generateLargeUtilityFile = () => {
    let functions = "";

    for (let i = 1; i <= 50; i++) {
        functions += `
function utilityFunction${i}(input) {
    let result = input;
    for (let j = 0; j < 20; j++) {
        result += j;
    }
    return result;
}
`;
    }

    return functions;
};

const generateServiceFile = () => {
    return `
const { utilityFunction10, utilityFunction20 } = require('./utils');

function processPayment(amount) {
    const tax = calculateTax(amount);
    return utilityFunction10(tax);
}

function calculateTax(amount) {
    return amount * 0.18;
}

function refundPayment(amount) {
    return utilityFunction20(amount);
}

module.exports = { processPayment, calculateTax, refundPayment };
`;
};

const generateControllerFile = () => {
    return `
const express = require('express');
const { processPayment, refundPayment } = require('./service');

const router = express.Router();

router.post('/pay', (req, res) => {
    const result = processPayment(req.body.amount);
    res.json({ result });
});

router.post('/refund', (req, res) => {
    const result = refundPayment(req.body.amount);
    res.json({ result });
});

module.exports = router;
`;
};

const mockRepoFiles = [
    {
        path: "src/utils.js",
        content: generateLargeUtilityFile()
    },
    {
        path: "src/service.js",
        content: generateServiceFile()
    },
    {
        path: "src/controller.js",
        content: generateControllerFile()
    }
];

const mockMetadata = {
    owner: "AnnujKumar",
    repo: "LargeMockRepo",
    defaultBranch: "main"
};

module.exports = { mockRepoFiles, mockMetadata };
