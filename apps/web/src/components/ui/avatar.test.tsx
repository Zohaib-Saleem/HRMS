// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './avatar';

/**
 * One person, one circle.
 *
 * This component is the whole of the "show the photo everywhere" requirement:
 * the people list, the org chart, the profile header and the direct-reports
 * list all render it, so what it decides is what every one of those screens
 * shows. Nothing else in the app chooses between a photograph and initials.
 *
 * Three properties matter:
 *
 *   - No photo means initials, which is exactly what the system did before
 *     photos existed. That is the fallback, not an error state.
 *   - A photo replaces them, cropped rather than squashed. An avatar that
 *     stretched a portrait to fill a square would be worse than initials.
 *   - A photo that fails to load falls back to initials rather than leaving a
 *     broken frame. This is not hypothetical: the image is served behind the
 *     same permission as the record, so a viewer who may see somebody in a list
 *     without being allowed to open their file gets a 403 for the image.
 */

afterEach(cleanup);

/** The avatar is decorative, so it is found by test id rather than by role. */
const circle = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe('an employee with no photo', () => {
  it('shows their initials', () => {
    const { container } = render(<Avatar name="Muhammad AbuBakar" colorKey="emp-1" />);

    expect(circle(container)).toHaveTextContent('MA');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows initials for a null photo, which is what the API sends', () => {
    const { container } = render(<Avatar name="Awais Zahid" photoUrl={null} colorKey="emp-2" />);

    expect(circle(container)).toHaveTextContent('AZ');
  });

  it('uses the first letter alone for a single-word name', () => {
    const { container } = render(<Avatar name="Prince" />);

    expect(circle(container)).toHaveTextContent('P');
  });

  it('gives the same person the same colour every time', () => {
    const { container: a } = render(<Avatar name="Muhammad AbuBakar" colorKey="emp-1" />);
    const first = circle(a).getAttribute('style');
    cleanup();
    const { container: b } = render(<Avatar name="Different Name" colorKey="emp-1" />);

    expect(circle(b).getAttribute('style')).toBe(first);
  });
});

describe('an employee with a photo', () => {
  const PHOTO = '/api/v1/employees/emp-1/photo?v=2026-09-14T00%3A00%3A00.000Z';

  it('shows the photo instead of initials', () => {
    const { container } = render(
      <Avatar name="Muhammad AbuBakar" photoUrl={PHOTO} colorKey="emp-1" />,
    );

    const image = container.querySelector('img');
    expect(image).toBeInTheDocument();
    expect(image).toHaveAttribute('src', PHOTO);
    expect(container.textContent).toBe('');
  });

  it('crops rather than stretches, so the aspect ratio survives', () => {
    const { container } = render(<Avatar name="Muhammad AbuBakar" photoUrl={PHOTO} />);

    const image = container.querySelector('img')!;
    // A square frame plus object-cover: the crop varies, the proportions do not.
    expect(image.className).toContain('object-cover');
    expect(image.className).toContain('rounded-full');
    expect(image.className).toContain('size-9');
  });

  it('keeps the circle the same size at every size it is asked for', () => {
    for (const [size, expected] of [
      ['sm', 'size-7'],
      ['md', 'size-9'],
      ['lg', 'size-12'],
      ['xl', 'size-20'],
    ] as const) {
      const { container } = render(<Avatar name="A B" photoUrl={PHOTO} size={size} />);
      expect(container.querySelector('img')!.className).toContain(expected);
      cleanup();
    }
  });

  it('falls back to initials when the image cannot be loaded', () => {
    const { container } = render(
      <Avatar name="Muhammad AbuBakar" photoUrl={PHOTO} colorKey="emp-1" />,
    );

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toBeNull();
    expect(circle(container)).toHaveTextContent('MA');
  });

  it('tries again when the photo changes, rather than staying failed forever', () => {
    const { container, rerender } = render(<Avatar name="A B" photoUrl={PHOTO} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<Avatar name="A B" photoUrl={`${PHOTO}-replaced`} />);

    expect(container.querySelector('img')).toBeInTheDocument();
  });
});

describe('removing a photo', () => {
  it('returns the avatar to initials', () => {
    const { container, rerender } = render(
      <Avatar name="Muhammad AbuBakar" photoUrl="/api/v1/employees/emp-1/photo" colorKey="emp-1" />,
    );
    expect(container.querySelector('img')).toBeInTheDocument();

    // What the API answers after a removal: no photo, and no typed link either.
    rerender(<Avatar name="Muhammad AbuBakar" photoUrl={null} colorKey="emp-1" />);

    expect(container.querySelector('img')).toBeNull();
    expect(circle(container)).toHaveTextContent('MA');
  });
});

describe('the avatar as other screens use it', () => {
  it('renders a list of people, each with their own photo or initials', () => {
    // The shape a people list, an org chart or a reports list hands it.
    const people = [
      { id: 'e1', fullName: 'Muhammad AbuBakar', photoUrl: '/api/v1/employees/e1/photo' },
      { id: 'e2', fullName: 'Awais Zahid', photoUrl: null },
    ];

    render(
      <ul>
        {people.map((p) => (
          <li key={p.id} data-testid={p.id}>
            <Avatar name={p.fullName} photoUrl={p.photoUrl} colorKey={p.id} size="sm" />
          </li>
        ))}
      </ul>,
    );

    expect(screen.getByTestId('e1').querySelector('img')).toHaveAttribute(
      'src',
      '/api/v1/employees/e1/photo',
    );
    expect(screen.getByTestId('e2').querySelector('img')).toBeNull();
    expect(screen.getByTestId('e2')).toHaveTextContent('AZ');
  });
});
