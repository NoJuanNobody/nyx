import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LivingSchemaPreview } from '../../../components/generative/LivingSchemaPreview';

describe('LivingSchemaPreview', () => {
  it('renders entity name and schema type badge', () => {
    render(
      <LivingSchemaPreview
        entityName="User"
        entityDescription="Represents a registered user"
        schemaType="entity"
      />,
    );

    expect(screen.getByTestId('living-schema-preview')).toBeTruthy();
    expect(screen.getByText('User')).toBeTruthy();
    expect(screen.getByText('entity')).toBeTruthy();
    expect(screen.getByText('Represents a registered user')).toBeTruthy();
  });

  it('renders field rows', () => {
    render(
      <LivingSchemaPreview
        entityName="Order"
        fields={[
          { name: 'id', type: 'uuid', required: true, description: 'Primary key' },
          { name: 'userId', type: 'uuid', references: 'User', description: 'Owner' },
          { name: 'total', type: 'integer', description: 'Total in cents' },
        ]}
      />,
    );

    expect(screen.getByText('id')).toBeTruthy();
    expect(screen.getByText('userId')).toBeTruthy();
    expect(screen.getByText('total')).toBeTruthy();
    expect(screen.getByText('→ User')).toBeTruthy();
    expect(screen.getByText('Primary key')).toBeTruthy();
  });

  it('shows waiting message when no fields provided', () => {
    render(<LivingSchemaPreview entityName="Empty" />);
    expect(screen.getByText('Waiting for schema fields…')).toBeTruthy();
  });

  it('renders related entities', () => {
    render(
      <LivingSchemaPreview
        entityName="Invoice"
        relatedEntities={[
          { name: 'LineItem', description: 'Invoice line items', fields: [] },
          { name: 'Customer', description: 'Billing customer', fields: [] },
        ]}
      />,
    );

    expect(screen.getByText('LineItem')).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();
  });

  it('defaults to entity schemaType', () => {
    render(<LivingSchemaPreview entityName="Widget" />);
    expect(screen.getByText('entity')).toBeTruthy();
  });
});
