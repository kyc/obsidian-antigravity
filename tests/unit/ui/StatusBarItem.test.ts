import { StatusBarItem } from '../../../src/ui/StatusBarItem';

describe('StatusBarItem', () => {
  let mockPlugin: any;
  let mockStatusBarEl: any;
  let statusBarItem: StatusBarItem;

  beforeEach(() => {
    mockPlugin = {
      registerDomEvent: jest.fn(),
    };
    const createMockElement = () => ({
      createSpan: jest.fn().mockImplementation(() => createMockElement()),
      createDiv: jest.fn().mockImplementation(() => createMockElement()),
      createEl: jest.fn().mockImplementation(() => createMockElement()),
      hide: jest.fn(),
      show: jest.fn(),
      setText: jest.fn(),
    });

    mockStatusBarEl = {
      createDiv: jest.fn().mockReturnValue(createMockElement()),
      createEl: jest.fn().mockReturnValue(createMockElement()),
    };
    statusBarItem = new StatusBarItem(mockPlugin, mockStatusBarEl);
  });

  it('registers click event through plugin.registerDomEvent', () => {
    expect(mockPlugin.registerDomEvent).toHaveBeenCalledTimes(1);
    expect(mockPlugin.registerDomEvent).toHaveBeenCalledWith(
      expect.anything(),
      'click',
      expect.any(Function),
    );
  });

  it('updates state to running with message', () => {
    statusBarItem.update('running', 'Indexing vault...');
    // No error thrown
  });
});
