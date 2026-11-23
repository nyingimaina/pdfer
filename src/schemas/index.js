'use strict';

/**
 * Demo document types, registered in code at startup (SPEC S1).
 *
 * `invoice-footer` is a synthetic document type (base BRS Appendix E-1) that
 * shares the invoice placeholder schema, so footer templates validate against
 * the same tokens as the document they decorate.
 */

function invoiceRoot() {
  return [
    {
      name: 'invoiceNumber',
      displayLabel: 'Invoice number',
      group: 'Header',
      dataType: 'string',
      isRequired: true,
      sampleValue: 'INV-0000'
    },
    {
      name: 'issuedOn',
      displayLabel: 'Issue date',
      group: 'Header',
      dataType: 'date',
      isRequired: true,
      formatHint: 'yyyy-MM-dd',
      sampleValue: '2026-01-31'
    },
    {
      name: 'dueOn',
      displayLabel: 'Due date',
      group: 'Header',
      dataType: 'date',
      isRequired: false,
      formatHint: 'yyyy-MM-dd',
      sampleValue: '2026-02-28'
    },
    {
      name: 'customerName',
      displayLabel: 'Customer name',
      group: 'Header',
      dataType: 'string',
      isRequired: true,
      sampleValue: 'EXAMPLE CUSTOMER'
    },
    {
      name: 'customerAddress',
      displayLabel: 'Customer address',
      group: 'Header',
      dataType: 'string',
      isRequired: false,
      sampleValue: '1 EXAMPLE STREET\nEXAMPLE CITY'
    },
    {
      name: 'items',
      displayLabel: 'Line items',
      group: 'Lines',
      dataType: 'collection',
      isCollection: true,
      isRequired: false,
      loopVariable: 'item',
      sampleValue: null,
      children: [
        {
          name: 'description',
          displayLabel: 'Description',
          group: 'Lines',
          dataType: 'string',
          isRequired: true,
          sampleValue: 'EXAMPLE ITEM'
        },
        {
          name: 'quantity',
          displayLabel: 'Quantity',
          group: 'Lines',
          dataType: 'number',
          isRequired: true,
          formatHint: '0',
          sampleValue: 2
        },
        {
          name: 'unitPrice',
          displayLabel: 'Unit price',
          group: 'Lines',
          dataType: 'money',
          isRequired: true,
          formatHint: '#,##0.00',
          sampleValue: 500
        },
        {
          name: 'lineTotal',
          displayLabel: 'Line total',
          group: 'Lines',
          dataType: 'money',
          isRequired: true,
          formatHint: '#,##0.00',
          sampleValue: 1000
        }
      ]
    },
    {
      name: 'total',
      displayLabel: 'Total',
      group: 'Totals',
      dataType: 'money',
      isRequired: true,
      formatHint: '#,##0.00',
      sampleValue: 1250.5
    },
    {
      name: 'notes',
      displayLabel: 'Notes',
      group: 'Footer',
      dataType: 'string',
      isRequired: false,
      sampleValue: 'EXAMPLE NOTE'
    }
  ];
}

const SCHEMAS = [
  {
    documentType: 'invoice',
    schemaVersion: 1,
    root: invoiceRoot()
  },
  {
    documentType: 'invoice-footer',
    schemaVersion: 1,
    root: invoiceRoot()
  },
  {
    documentType: 'invoice-header',
    schemaVersion: 1,
    root: invoiceRoot()
  }
];

module.exports = { SCHEMAS };

/**
 * Loads deployment-provided schema definitions (SPEC v1.1.1 §12).
 * The file is read-only configuration, not user input: schemas stay
 * code/repo-owned (S1), they just travel with the deployment manifest.
 */
async function loadSchemasFromFile(file) {
  const fs = require('node:fs/promises');
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.schemas;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Schema manifest '${file}' must contain a non-empty "schemas" array`);
  }
  return list;
}

module.exports.loadSchemasFromFile = loadSchemasFromFile;
